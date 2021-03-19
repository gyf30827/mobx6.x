import {
    IAtom,
    IDepTreeNode,
    IObservable,
    addObserver,
    globalState,
    isComputedValue,
    removeObserver
} from "../internal"

export enum IDerivationState_ {
    // before being run or (outside batch and not being observed)
    // at this point derivation is not holding any data about dependency tree
    // 初始化状态
    NOT_TRACKING_ = -1,
    // 自上次计算以来，没有更改浅层依赖关系
    // no shallow dependency changed since last computation
    // 没有重新计算导出
    // won't recalculate derivation
    // 提高效率
    // this is what makes mobx fast
    UP_TO_DATE_ = 0,
    // 一些深层依赖发生改变，但是不知道浅层依赖是否改变
    // some deep dependency changed, but don't know if shallow dependency changed
    // 首先需要检查 UP_TO_DATE 或者 POSSIBLY_STALE
    // will require to check first if UP_TO_DATE or POSSIBLY_STALE
    // 当前只有计算属性包含 POSSIBLY_STALE 这个状态
    // currently only ComputedValue will propagate POSSIBLY_STALE
    // 有这个状态是做的第二大优化
    // having this state is second big optimization:
    // 不需要在每次依赖变化时进行重新计算，只有需要时才计算
    // don't have to recompute on every dependency change, but only when it's needed
    POSSIBLY_STALE_ = 1,
    // 从上次计算派生开始，一些浅依赖发生改变
    // A shallow dependency has changed since last computation and the derivation
    // 当下一次需要计算时，将需要重新计算
    // will need to recompute when it's needed next.
    STALE_ = 2
}

export enum TraceMode {
    NONE,
    LOG,
    BREAK
}

/**
 * A derivation is everything that can be derived from the state (all the atoms) in a pure manner.
 * See https://medium.com/@mweststrate/becoming-fully-reactive-an-in-depth-explanation-of-mobservable-55995262a254#.xvbh6qd74
 */
export interface IDerivation extends IDepTreeNode {
    observing_: IObservable[]
    newObserving_: null | IObservable[]
    dependenciesState_: IDerivationState_
    /**
     * Id of the current run of a derivation. Each time the derivation is tracked
     * this number is increased by one. This number is globally unique
     */
    runId_: number
    /**
     * amount of dependencies used by the derivation in this run, which has not been bound yet.
     */
    unboundDepsCount_: number
    onBecomeStale_(): void
    isTracing_: TraceMode

    /**
     *  warn if the derivation has no dependencies after creation/update
     */
    requiresObservable_?: boolean
}

export class CaughtException {
    constructor(public cause: any) {
        // Empty
    }
}

export function isCaughtException(e: any): e is CaughtException {
    return e instanceof CaughtException
}

/**
 * Finds out whether any dependency of the derivation has actually changed.
 * If dependenciesState is 1 then it will recalculate dependencies,
 * if any dependency changed it will propagate it by changing dependenciesState to 2.
 *
 * By iterating over the dependencies in the same order that they were reported and
 * stopping on the first change, all the recalculations are only called for ComputedValues
 * that will be tracked by derivation. That is because we assume that if the first x
 * dependencies of the derivation doesn't change then the derivation should run the same way
 * up until accessing x-th dependency.
 */
// 判断当前计算属性值是否发生改变
export function shouldCompute(derivation: IDerivation): boolean {
    switch (derivation.dependenciesState_) {
        case IDerivationState_.UP_TO_DATE_:
            return false
        case IDerivationState_.NOT_TRACKING_:
        case IDerivationState_.STALE_:
            return true
        case IDerivationState_.POSSIBLY_STALE_: {
            // state propagation can occur outside of action/reactive context #2195
            const prevAllowStateReads = allowStateReadsStart(true)
            const prevUntracked = untrackedStart() // no need for those computeds to be reported, they will be picked up in trackDerivedFunction.
            // 依赖的数据列表
            const obs = derivation.observing_,
                l = obs.length
            for (let i = 0; i < l; i++) {
                const obj = obs[i]
                if (isComputedValue(obj)) {
                    if (globalState.disableErrorBoundaries) {
                        obj.get()
                    } else {
                        try {
                            obj.get()
                        } catch (e) {
                            // we are not interested in the value *or* exception at this moment, but if there is one, notify all
                            untrackedEnd(prevUntracked)
                            allowStateReadsEnd(prevAllowStateReads)
                            return true
                        }
                    }
                    // if ComputedValue `obj` actually changed it will be computed and propagated to its observers.
                    // and `derivation` is an observer of `obj`
                    // invariantShouldCompute(derivation)
                    if ((derivation.dependenciesState_ as any) === IDerivationState_.STALE_) {
                        untrackedEnd(prevUntracked)
                        allowStateReadsEnd(prevAllowStateReads)
                        return true
                    }
                }
            }
            changeDependenciesStateTo0(derivation)
            untrackedEnd(prevUntracked)
            allowStateReadsEnd(prevAllowStateReads)
            return false
        }
    }
}

export function isComputingDerivation() {
    return globalState.trackingDerivation !== null // filter out actions inside computations
}

export function checkIfStateModificationsAreAllowed(atom: IAtom) {
    if (!__DEV__) {
        return
    }
    const hasObservers = atom.observers_.size > 0
    // 在严格模式之外不可能改变被观察状态，除非在初始化期间，参见#563
    // Should not be possible to change observed state outside strict mode, except during initialization, see #563
    if (!globalState.allowStateChanges && (hasObservers || globalState.enforceActions === "always"))
        console.warn(
            "[MobX] " +
                (globalState.enforceActions
                    ? "Since strict-mode is enabled, changing (observed) observable values without using an action is not allowed. Tried to modify: "
                    : "Side effects like changing state are not allowed at this point. Are you trying to modify state from, for example, a computed value or the render function of a React component? You can wrap side effects in 'runInAction' (or decorate functions with 'action') if needed. Tried to modify: ") +
                atom.name_
        )
}

export function checkIfStateReadsAreAllowed(observable: IObservable) {
    if (__DEV__ && !globalState.allowStateReads && globalState.observableRequiresReaction) {
        console.warn(`[mobx] Observable ${observable.name_} being read outside a reactive context`)
    }
}

/**
 * 执行所提供的函数“f”并跟踪哪些可观察对象正在被访问。
 * Executes the provided function `f` and tracks which observables are being accessed.
 * 跟踪信息存储在“派生”对象上，并注册派生
 * The tracking information is stored on the `derivation` object and the derivation is registered
 * 作为任何被访问的可观察对象的观察者。
 *  as observer of any of the accessed observables.
 */
export function trackDerivedFunction<T>(derivation: IDerivation, f: () => T, context: any) {
    const prevAllowStateReads = allowStateReadsStart(true)
    // pre allocate array allocation + room for variation in deps
    // array will be trimmed by bindDependencies
    changeDependenciesStateTo0(derivation)
    derivation.newObserving_ = new Array(derivation.observing_.length + 100)
    derivation.unboundDepsCount_ = 0
    derivation.runId_ = ++globalState.runId
    const prevTracking = globalState.trackingDerivation
    globalState.trackingDerivation = derivation
    globalState.inBatch++
    let result
    if (globalState.disableErrorBoundaries === true) {
        result = f.call(context)
    } else {
        try {
            result = f.call(context)
        } catch (e) {
            result = new CaughtException(e)
        }
    }
    globalState.inBatch--
    globalState.trackingDerivation = prevTracking
    bindDependencies(derivation)

    warnAboutDerivationWithoutDependencies(derivation)
    allowStateReadsEnd(prevAllowStateReads)
    return result
}

function warnAboutDerivationWithoutDependencies(derivation: IDerivation) {
    if (!__DEV__) return

    if (derivation.observing_.length !== 0) return

    if (globalState.reactionRequiresObservable || derivation.requiresObservable_) {
        console.warn(
            `[mobx] Derivation ${derivation.name_} is created/updated without reading any observable value`
        )
    }
}

/**
 * diffs newObserving with observing.
 * update observing to be newObserving with unique observables
 * notify observers that become observed/unobserved
 */
function bindDependencies(derivation: IDerivation) {
    // invariant(derivation.dependenciesState !== IDerivationState.NOT_TRACKING, "INTERNAL ERROR bindDependencies expects derivation.dependenciesState !== -1");
    const prevObserving = derivation.observing_
    const observing = (derivation.observing_ = derivation.newObserving_!)
    let lowestNewObservingDerivationState = IDerivationState_.UP_TO_DATE_
    // 遍历所有新的observable并检查diffValue:(该列表可以包含重复项):
    // Go through all new observables and check diffValue: (this list can contain duplicates):
    // 0:第一次出现，更改为1并保留它
    // 0: first occurrence, change to 1 and keep it
    // 1:额外的出现，扔掉它
    // 1: extra occurrence, drop it
    // 去掉新的被观察者，中重复的
    let i0 = 0,
        l = derivation.unboundDepsCount_
    for (let i = 0; i < l; i++) {
        const dep = observing[i]
        if (dep.diffValue_ === 0) {
            dep.diffValue_ = 1
            if (i0 !== i) observing[i0] = dep
            i0++
        }
        // Upcast is 'safe' here, because if dep is IObservable, `dependenciesState` will be undefined,
        // not hitting the condition
        // 判断新加入的观测对象的值是否需要更新
        if (((dep as any) as IDerivation).dependenciesState_ > lowestNewObservingDerivationState) {
            lowestNewObservingDerivationState = ((dep as any) as IDerivation).dependenciesState_
        }
    }
    observing.length = i0

    derivation.newObserving_ = null // newObserving shouldn't be needed outside tracking (statement moved down to work around FF bug, see #614)

    // Go through all old observables and check diffValue: (it is unique after last bindDependencies)
    //   0: it's not in new observables, unobserve it
    //   1: it keeps being observed, don't want to notify it. change to 0
    // 去除老旧的关联
    l = prevObserving.length
    while (l--) {
        const dep = prevObserving[l]
        if (dep.diffValue_ === 0) {
            removeObserver(dep, derivation)
        }
        dep.diffValue_ = 0
    }

    // Go through all new observables and check diffValue: (now it should be unique)
    //   0: it was set to 0 in last loop. don't need to do anything.
    //   1: it wasn't observed, let's observe it. set back to 0
    // 将当前 derivation 添加到依赖的 observavle.observaers_ 中
    while (i0--) {
        const dep = observing[i0]
        if (dep.diffValue_ === 1) {
            dep.diffValue_ = 0
            addObserver(dep, derivation)
        }
    }
    // 在这个推导计算过程中，一些新的观测到的推导结果可能会变得陈旧
    // Some new observed derivations may become stale during this derivation computation
    // so they have had no chance to propagate staleness (#916)
    if (lowestNewObservingDerivationState !== IDerivationState_.UP_TO_DATE_) {
        derivation.dependenciesState_ = lowestNewObservingDerivationState
        // 向上广播数据变化
        derivation.onBecomeStale_()
    }
}

export function clearObserving(derivation: IDerivation) {
    // invariant(globalState.inBatch > 0, "INTERNAL ERROR clearObserving should be called only inside batch");
    const obs = derivation.observing_
    derivation.observing_ = []
    let i = obs.length
    while (i--) removeObserver(obs[i], derivation)

    derivation.dependenciesState_ = IDerivationState_.NOT_TRACKING_
}

export function untracked<T>(action: () => T): T {
    const prev = untrackedStart()
    try {
        return action()
    } finally {
        untrackedEnd(prev)
    }
}

export function untrackedStart(): IDerivation | null {
    const prev = globalState.trackingDerivation
    globalState.trackingDerivation = null
    return prev
}

export function untrackedEnd(prev: IDerivation | null) {
    globalState.trackingDerivation = prev
}

export function allowStateReadsStart(allowStateReads: boolean) {
    const prev = globalState.allowStateReads
    globalState.allowStateReads = allowStateReads
    return prev
}

export function allowStateReadsEnd(prev: boolean) {
    globalState.allowStateReads = prev
}

/**
 * 保持lowestObserverState 的正确性， 当从 2 | 1 变为 0的时候
 * needed to keep `lowestObserverState` correct. when changing from (2 or 1) to 0
 *
 */
export function changeDependenciesStateTo0(derivation: IDerivation) {
    if (derivation.dependenciesState_ === IDerivationState_.UP_TO_DATE_) return
    derivation.dependenciesState_ = IDerivationState_.UP_TO_DATE_

    const obs = derivation.observing_
    let i = obs.length
    while (i--) obs[i].lowestObserverState_ = IDerivationState_.UP_TO_DATE_
}
