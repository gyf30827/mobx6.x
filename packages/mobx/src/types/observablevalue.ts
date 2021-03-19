import {
    Atom,
    IEnhancer,
    IInterceptable,
    IEqualsComparer,
    IInterceptor,
    IListenable,
    Lambda,
    checkIfStateModificationsAreAllowed,
    comparer,
    createInstanceofPredicate,
    getNextId,
    hasInterceptors,
    hasListeners,
    interceptChange,
    isSpyEnabled,
    notifyListeners,
    registerInterceptor,
    registerListener,
    spyReport,
    spyReportEnd,
    spyReportStart,
    toPrimitive,
    globalState,
    IUNCHANGED,
    UPDATE
} from "../internal"

export interface IValueWillChange<T> {
    object: IObservableValue<T>
    type: "update"
    newValue: T
}

export type IValueDidChange<T = any> = {
    type: "update"
    observableKind: "value"
    object: IObservableValue<T>
    debugObjectName: string
    newValue: unknown
    oldValue: unknown
}
export type IBoxDidChange<T = any> =
    | {
          type: "create"
          observableKind: "value"
          object: IObservableValue<T>
          debugObjectName: string
          newValue: unknown
      }
    | IValueDidChange<T>

export interface IObservableValue<T> {
    get(): T
    set(value: T): void
    intercept_(handler: IInterceptor<IValueWillChange<T>>): Lambda
    observe_(listener: (change: IValueDidChange<T>) => void, fireImmediately?: boolean): Lambda
}

const CREATE = "create"

export class ObservableValue<T>
    extends Atom
    implements IObservableValue<T>, IInterceptable<IValueWillChange<T>>, IListenable {
    hasUnreportedChange_ = false
    // 拦截器
    interceptors_
    // 注册的变化时触发的回调列表
    changeListeners_
    value_
    dehancer: any

    constructor(
        value: T,
        public enhancer: IEnhancer<T>,
        public name_ = __DEV__ ? "ObservableValue@" + getNextId() : "ObservableValue",
        notifySpy = true,
        private equals: IEqualsComparer<any> = comparer.default
    ) {
        super(name_)
        this.value_ = enhancer(value, undefined, name_)
        if (__DEV__ && notifySpy && isSpyEnabled()) {
            // only notify spy if this is a stand-alone observable
            spyReport({
                type: CREATE,
                object: this,
                observableKind: "value",
                debugObjectName: this.name_,
                newValue: "" + this.value_
            })
        }
    }

    private dehanceValue(value: T): T {
        if (this.dehancer !== undefined) return this.dehancer(value)
        return value
    }
    // 当赋值时调用
    public set(newValue: T) {
        const oldValue = this.value_
        newValue = this.prepareNewValue_(newValue) as any
        if (newValue !== globalState.UNCHANGED) {
            const notifySpy = isSpyEnabled()
            if (__DEV__ && notifySpy) {
                spyReportStart({
                    type: UPDATE,
                    object: this,
                    observableKind: "value",
                    debugObjectName: this.name_,
                    newValue,
                    oldValue
                })
            }
            this.setNewValue_(newValue)
            if (__DEV__ && notifySpy) spyReportEnd()
        }
    }

    private prepareNewValue_(newValue): T | IUNCHANGED {
        // 检查当前是否可以进行赋值操作
        checkIfStateModificationsAreAllowed(this)
        if (hasInterceptors(this)) {
            const change = interceptChange<IValueWillChange<T>>(this, {
                object: this,
                type: UPDATE,
                newValue
            })
            if (!change) return globalState.UNCHANGED
            newValue = change.newValue
        }
        // 将 新的值劫持后返回 或者返回 globalState.UNCHANGED 
        // apply modifier
        newValue = this.enhancer(newValue, this.value_, this.name_)
        return this.equals(this.value_, newValue) ? globalState.UNCHANGED : newValue
    }
    // 赋新值
    setNewValue_(newValue: T) {
        const oldValue = this.value_
        this.value_ = newValue
        // 广播值变化
        this.reportChanged()
        if (hasListeners(this)) {
            notifyListeners(this, {
                type: UPDATE,
                object: this,
                newValue,
                oldValue
            })
        }
    }

    public get(): T {
        this.reportObserved()
        return this.dehanceValue(this.value_)
    }
    // 添加拦截器 可以用来在任何变化应用前将其拦截改变
    intercept_(handler: IInterceptor<IValueWillChange<T>>): Lambda {
        return registerInterceptor(this, handler)
    }
    // 添加监听  数据变化时触发回调函数
    observe_(listener: (change: IValueDidChange<T>) => void, fireImmediately?: boolean): Lambda {
        if (fireImmediately)
            listener({
                observableKind: "value",
                debugObjectName: this.name_,
                object: this,
                type: UPDATE,
                newValue: this.value_,
                oldValue: undefined
            })
        return registerListener(this, listener)
    }

    raw() {
        // used by MST ot get undehanced value
        return this.value_
    }

    toJSON() {
        return this.get()
    }

    toString() {
        return `${this.name_}[${this.value_}]`
    }

    valueOf(): T {
        return toPrimitive(this.get())
    }

    [Symbol.toPrimitive]() {
        return this.valueOf()
    }
}

export const isObservableValue = createInstanceofPredicate("ObservableValue", ObservableValue) as (
    x: any
) => x is IObservableValue<any>
