import {
    IDerivationState_,
    IObservable,
    IDerivation,
    createInstanceofPredicate,
    endBatch,
    getNextId,
    noop,
    onBecomeObserved,
    onBecomeUnobserved,
    propagateChanged,
    reportObserved,
    startBatch,
    Lambda
} from "../internal"

// mobx 对象的唯一标识
export const $mobx = Symbol("mobx administration")

export interface IAtom extends IObservable {
    reportObserved()
    reportChanged()
}

export class Atom implements IAtom {
    // 是否等待处理为被观测对象
    isPendingUnobservation_ = false // for effective unobserving. BaseAtom has true, for extra optimization, so its onBecomeUnobserved never gets called, because it's not needed
    isBeingObserved_ = false
    observers_ = new Set<IDerivation>()

    diffValue_ = 0
    lastAccessedBy_ = 0
    // 标志observable的状态。这个值在性能优化过程中发挥很大的作用。关于性能优化
    lowestObserverState_ = IDerivationState_.NOT_TRACKING_
    /**
     * Create a new atom. For debugging purposes it is recommended to give it a name.
     * The onBecomeObserved and onBecomeUnobserved callbacks can be used for resource management.
     */
    constructor(public name_ = __DEV__ ? "Atom@" + getNextId() : "Atom") {}

    // onBecomeObservedListeners
    public onBOL: Set<Lambda> | undefined
    // onBecomeUnobservedListeners
    public onBUOL: Set<Lambda> | undefined
    // TODO: 不知道用来改啥的
    public onBO() {
        if (this.onBOL) {
            this.onBOL.forEach(listener => listener())
        }
    }
    // TODO: 不知道用来改啥的
    public onBUO() {
        if (this.onBUOL) {
            this.onBUOL.forEach(listener => listener())
        }
    }

    /**
     * Invoke this method to notify mobx that your atom has been used somehow.
     * Returns true if there is currently a reactive context.
     */
    // 对象被使用时调用 广播此对象已经被调用
    public reportObserved(): boolean {
        return reportObserved(this)
    }

    /**
     * Invoke this method _after_ this method has changed to signal mobx that all its observers should invalidate.
     */
    //  对象被修改时调用
    public reportChanged() {
        startBatch()
        propagateChanged(this)
        endBatch()
    }

    toString() {
        return this.name_
    }
}
// 判断是否Atom 类实例
export const isAtom = createInstanceofPredicate("Atom", Atom)

export function createAtom(
    name: string,
    onBecomeObservedHandler: () => void = noop,
    onBecomeUnobservedHandler: () => void = noop
): IAtom {
    const atom = new Atom(name)
    // default `noop` listener will not initialize the hook Set
    if (onBecomeObservedHandler !== noop) {
        onBecomeObserved(atom, onBecomeObservedHandler)
    }

    if (onBecomeUnobservedHandler !== noop) {
        onBecomeUnobserved(atom, onBecomeUnobservedHandler)
    }
    return atom
}
