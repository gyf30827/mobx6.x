import {
    Lambda,
    ComputedValue,
    IDependencyTree,
    IDerivation,
    IDerivationState_,
    TraceMode,
    getDependencyTree,
    globalState,
    runReactions,
    checkIfStateReadsAreAllowed
} from "../internal"

export interface IDepTreeNode {
    name_: string
    observing_?: IObservable[]
}

export interface IObservable extends IDepTreeNode {
    diffValue_: number
    /**
     * Id of the derivation *run* that last accessed this observable.
     * If this id equals the *run* id of the current derivation,
     * the dependency is already established
     */
    lastAccessedBy_: number
    isBeingObserved_: boolean

    lowestObserverState_: IDerivationState_ // Used to avoid redundant propagations
    isPendingUnobservation_: boolean // Used to push itself to global.pendingUnobservations at most once per batch.

    observers_: Set<IDerivation>

    onBUO(): void
    onBO(): void

    onBUOL: Set<Lambda> | undefined
    onBOL: Set<Lambda> | undefined
}

export function hasObservers(observable: IObservable): boolean {
    return observable.observers_ && observable.observers_.size > 0
}

export function getObservers(observable: IObservable): Set<IDerivation> {
    return observable.observers_
}

// function invariantObservers(observable: IObservable) {
//     const list = observable.observers
//     const map = observable.observersIndexes
//     const l = list.length
//     for (let i = 0; i < l; i++) {
//         const id = list[i].__mapid
//         if (i) {
//             invariant(map[id] === i, "INTERNAL ERROR maps derivation.__mapid to index in list") // for performance
//         } else {
//             invariant(!(id in map), "INTERNAL ERROR observer on index 0 shouldn't be held in map.") // for performance
//         }
//     }
//     invariant(
//         list.length === 0 || Object.keys(map).length === list.length - 1,
//         "INTERNAL ERROR there is no junk in map"
//     )
// }
export function addObserver(observable: IObservable, node: IDerivation) {
    // invariant(node.dependenciesState !== -1, "INTERNAL ERROR, can add only dependenciesState !== -1");
    // invariant(observable._observers.indexOf(node) === -1, "INTERNAL ERROR add already added node");
    // invariantObservers(observable);

    observable.observers_.add(node)
    if (observable.lowestObserverState_ > node.dependenciesState_)
        observable.lowestObserverState_ = node.dependenciesState_

    // invariantObservers(observable);
    // invariant(observable._observers.indexOf(node) !== -1, "INTERNAL ERROR didn't add node");
}

export function removeObserver(observable: IObservable, node: IDerivation) {
    // invariant(globalState.inBatch > 0, "INTERNAL ERROR, remove should be called only inside batch");
    // invariant(observable._observers.indexOf(node) !== -1, "INTERNAL ERROR remove already removed node");
    // invariantObservers(observable);
    observable.observers_.delete(node)
    if (observable.observers_.size === 0) {
        // deleting last observer
        queueForUnobservation(observable)
    }
    // invariantObservers(observable);
    // invariant(observable._observers.indexOf(node) === -1, "INTERNAL ERROR remove already removed node2");
}
// 全局添加待处理的 observable
export function queueForUnobservation(observable: IObservable) {
    if (observable.isPendingUnobservation_ === false) {
        // invariant(observable._observers.length === 0, "INTERNAL ERROR, should only queue for unobservation unobserved observables");
        observable.isPendingUnobservation_ = true
        globalState.pendingUnobservations.push(observable)
    }
}

/**
 * Batch启动一个事务，至少是为了在没有其他操作时记忆计算值。
 * 在批处理过程中，每个可观察对象最多调用一次“onbecomeunoobserved”。
 * 避免不必要的重新计算。
 * Batch starts a transaction, at least for purposes of memoizing ComputedValues when nothing else does.
 * During a batch `onBecomeUnobserved` will be called at most once per observable.
 * Avoids unnecessary recalculations.
 */
export function startBatch() {
    globalState.inBatch++
}
// 结束批处理
// 当初标识为 0 时，处理待处理的 pendingUnobservations
export function endBatch() {
    if (--globalState.inBatch === 0) {
        runReactions()
        // the batch is actually about to finish, all unobserving should happen here.
        const list = globalState.pendingUnobservations
        for (let i = 0; i < list.length; i++) {
            const observable = list[i]
            observable.isPendingUnobservation_ = false
            if (observable.observers_.size === 0) {
                if (observable.isBeingObserved_) {
                    // if this observable had reactive observers, trigger the hooks
                    observable.isBeingObserved_ = false
                    observable.onBUO()
                }
                if (observable instanceof ComputedValue) {
                    // computed values are automatically teared down when the last observer leaves
                    // this process happens recursively, this computed might be the last observabe of another, etc..
                    observable.suspend_()
                }
            }
        }
        globalState.pendingUnobservations = []
    }
}

export function reportObserved(observable: IObservable): boolean {
    // 如果在读取上下文之外，log 警告
    checkIfStateReadsAreAllowed(observable)

    const derivation = globalState.trackingDerivation
    if (derivation !== null) {
        /**
         * 简单的优化，给每个派生运行一个唯一的id (runId)
         * Simple optimization, give each derivation run an unique id (runId)
         * 检查上次这个可观察对象被访问时是否使用了相同的runId
         * Check if last time this observable was accessed the same runId is used
         * 如果是这样，如果是这样，那么这种关系是已知的
         * if this is the case, the relation is already known
         */
        if (derivation.runId_ !== observable.lastAccessedBy_) {
            observable.lastAccessedBy_ = derivation.runId_
            // 尝试存储newObserving，或observing，或两者都设置，但性能没有接近…
            // Tried storing newObserving, or observing, or both as Set, but performance didn't come close...
            // 将当前 observable 添加到当前的派生对象的 newObserving_ 数字中
            derivation.newObserving_![derivation.unboundDepsCount_++] = observable
            if (!observable.isBeingObserved_ && globalState.trackingContext) {
                observable.isBeingObserved_ = true
                observable.onBO()
            }
        }
        return true
    } else if (observable.observers_.size === 0 && globalState.inBatch > 0) {
        queueForUnobservation(observable)
    }

    return false
}

// function invariantLOS(observable: IObservable, msg: string) {
//     // it's expensive so better not run it in produciton. but temporarily helpful for testing
//     const min = getObservers(observable).reduce((a, b) => Math.min(a, b.dependenciesState), 2)
//     if (min >= observable.lowestObserverState) return // <- the only assumption about `lowestObserverState`
//     throw new Error(
//         "lowestObserverState is wrong for " +
//             msg +
//             " because " +
//             min +
//             " < " +
//             observable.lowestObserverState
//     )
// }

/**
 * NOTE: current propagation mechanism will in case of self reruning autoruns behave unexpectedly
 * It will propagate changes to observers from previous run
 * It's hard or maybe impossible (with reasonable perf) to get it right with current approach
 * Hopefully self reruning autoruns aren't a feature people should depend on
 * Also most basic use cases should be ok
 */

// Called by Atom when its value changes
// 当 adm 实例的值发生变化时， 将值改变的消息，广播给它的观察者
export function propagateChanged(observable: IObservable) {
    // invariantLOS(observable, "changed start");
    if (observable.lowestObserverState_ === IDerivationState_.STALE_) return
    observable.lowestObserverState_ = IDerivationState_.STALE_

    // Ideally we use for..of here, but the downcompiled version is really slow...
    observable.observers_.forEach(d => {      
        if (d.dependenciesState_ === IDerivationState_.UP_TO_DATE_) {
            if (__DEV__ && d.isTracing_ !== TraceMode.NONE) {
                logTraceInfo(d, observable)
            }
            // 调用观察者的 onBecomeStale_ 方法，向上广播
            d.onBecomeStale_()
        }
        // 将观察者的值状态修改为依赖发生改变，再次调用时需要重新计算
        d.dependenciesState_ = IDerivationState_.STALE_
    })
    // invariantLOS(observable, "changed end");
}

// Called by ComputedValue when it recalculate and its value changed
// 当 ComputedValue  重新计算时，将值改变的信息传递给依赖它的观察者
export function propagateChangeConfirmed(observable: IObservable) {
    // invariantLOS(observable, "confirmed start");
    if (observable.lowestObserverState_ === IDerivationState_.STALE_) return
    observable.lowestObserverState_ = IDerivationState_.STALE_

    observable.observers_.forEach(d => {
        if (d.dependenciesState_ === IDerivationState_.POSSIBLY_STALE_)
            d.dependenciesState_ = IDerivationState_.STALE_
        else if (
            d.dependenciesState_ === IDerivationState_.UP_TO_DATE_ // this happens during computing of `d`, just keep lowestObserverState up to date.
        )
            observable.lowestObserverState_ = IDerivationState_.UP_TO_DATE_
    })
    // invariantLOS(observable, "confirmed end");
}

// Used by computed when its dependency changed, but we don't wan't to immediately recompute.
export function propagateMaybeChanged(observable: IObservable) {
    // invariantLOS(observable, "maybe start");
    if (observable.lowestObserverState_ !== IDerivationState_.UP_TO_DATE_) return
    observable.lowestObserverState_ = IDerivationState_.POSSIBLY_STALE_

    observable.observers_.forEach(d => {
        if (d.dependenciesState_ === IDerivationState_.UP_TO_DATE_) {
            d.dependenciesState_ = IDerivationState_.POSSIBLY_STALE_
            if (__DEV__ && d.isTracing_ !== TraceMode.NONE) {
                logTraceInfo(d, observable)
            }
            d.onBecomeStale_()
        }
    })
    // invariantLOS(observable, "maybe end");
}

function logTraceInfo(derivation: IDerivation, observable: IObservable) {
    console.log(
        `[mobx.trace] '${derivation.name_}' is invalidated due to a change in: '${observable.name_}'`
    )
    if (derivation.isTracing_ === TraceMode.BREAK) {
        const lines = []
        printDepTree(getDependencyTree(derivation), lines, 1)

        // prettier-ignore
        new Function(
`debugger;
/*
Tracing '${derivation.name_}'

You are entering this break point because derivation '${derivation.name_}' is being traced and '${observable.name_}' is now forcing it to update.
Just follow the stacktrace you should now see in the devtools to see precisely what piece of your code is causing this update
The stackframe you are looking for is at least ~6-8 stack-frames up.

${derivation instanceof ComputedValue ? derivation.derivation.toString().replace(/[*]\//g, "/") : ""}

The dependencies for this derivation are:

${lines.join("\n")}
*/
    `)()
    }
}

function printDepTree(tree: IDependencyTree, lines: string[], depth: number) {
    if (lines.length >= 1000) {
        lines.push("(and many more)")
        return
    }
    lines.push(`${new Array(depth).join("\t")}${tree.name}`) // MWE: not the fastest, but the easiest way :)
    if (tree.dependencies) tree.dependencies.forEach(child => printDepTree(child, lines, depth + 1))
}
