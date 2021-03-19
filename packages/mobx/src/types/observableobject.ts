import {
    CreateObservableOptions,
    getAnnotationFromOptions,
    propagateChanged,
    isAnnotation,
    $mobx,
    Atom,
    Annotation,
    ComputedValue,
    IAtom,
    IComputedValueOptions,
    IEnhancer,
    IInterceptable,
    IListenable,
    Lambda,
    ObservableValue,
    addHiddenProp,
    createInstanceofPredicate,
    endBatch,
    getNextId,
    hasInterceptors,
    hasListeners,
    interceptChange,
    isObject,
    isPlainObject,
    isSpyEnabled,
    notifyListeners,
    referenceEnhancer,
    registerInterceptor,
    registerListener,
    spyReportEnd,
    spyReportStart,
    startBatch,
    stringifyKey,
    globalState,
    observable,
    ADD,
    UPDATE,
    die,
    hasProp,
    getDescriptor,
    storedAnnotationsSymbol,
    ownKeys,
    isOverride,
    defineProperty,
    inferAnnotationFromDescriptor,
    getDebugName,
    getAdministration,
    objectPrototype
} from "../internal"

// closestPrototypeofTarget[inferredAnnotationsSymbol] = new Map<PropertyKes, Annotation>()
export const inferredAnnotationsSymbol = Symbol("mobx-inferred-annotations")
// descriptor缓存池
const descriptorCache = Object.create(null)

export type IObjectDidChange<T = any> = {
    observableKind: "object"
    name: PropertyKey
    object: T
    debugObjectName: string
} & (
    | {
          type: "add"
          newValue: any
      }
    | {
          type: "update"
          oldValue: any
          newValue: any
      }
    | {
          type: "remove"
          oldValue: any
      }
)

export type IObjectWillChange<T = any> =
    | {
          object: T
          type: "update" | "add"
          name: PropertyKey
          newValue: any
      }
    | {
          object: T
          type: "remove"
          name: PropertyKey
      }

const REMOVE = "remove"

export class ObservableObjectAdministration
    implements IInterceptable<IObjectWillChange>, IListenable {
    keysAtom_: IAtom
    changeListeners_
    interceptors_
    proxy_: any
    isPlainObject_: boolean
    appliedAnnotations_?: object
    private pendingKeys_: undefined | Map<PropertyKey, ObservableValue<boolean>>

    constructor(
        // 当前实例绑定的 对象
        public target_: any,
        public values_ = new Map<PropertyKey, ObservableValue<any> | ComputedValue<any>>(),
        public name_: string,
        // Used anytime annotation is not explicitely provided
        public defaultAnnotation_: Annotation = observable,
        // Bind automatically inferred actions?
        public autoBind_: boolean = false
    ) {
        this.keysAtom_ = new Atom(__DEV__ ? `${this.name_}.keys` : "ObservableObject.keys")
        // Optimization: we use this frequently
        this.isPlainObject_ = isPlainObject(this.target_)
        if (__DEV__ && !isAnnotation(this.defaultAnnotation_)) {
            die(`defaultAnnotation must be valid annotation`)
        }
        if (__DEV__ && typeof this.autoBind_ !== "boolean") {
            die(`autoBind must be boolean`)
        }
        if (__DEV__) {
            // Prepare structure for tracking which fields were already annotated
            this.appliedAnnotations_ = {}
        }
    }

    getObservablePropValue_(key: PropertyKey): any {
        return this.values_.get(key)!.get()
    }

    setObservablePropValue_(key: PropertyKey, newValue): boolean | null {
        const observable = this.values_.get(key)
        if (observable instanceof ComputedValue) {
            observable.set(newValue)
            return true
        }

        // intercept
        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                type: UPDATE,
                object: this.proxy_ || this.target_,
                name: key,
                newValue
            })
            if (!change) return null
            newValue = (change as any).newValue
        }
        newValue = (observable as any).prepareNewValue_(newValue)

        // notify spy & observers
        if (newValue !== globalState.UNCHANGED) {
            const notify = hasListeners(this)
            const notifySpy = __DEV__ && isSpyEnabled()
            const change: IObjectDidChange | null =
                notify || notifySpy
                    ? {
                          type: UPDATE,
                          observableKind: "object",
                          debugObjectName: this.name_,
                          object: this.proxy_ || this.target_,
                          oldValue: (observable as any).value_,
                          name: key,
                          newValue
                      }
                    : null

            if (__DEV__ && notifySpy) spyReportStart(change!)
            ;(observable as ObservableValue<any>).setNewValue_(newValue)
            if (notify) notifyListeners(this, change)
            if (__DEV__ && notifySpy) spyReportEnd()
        }
        return true
    }

    get_(key: PropertyKey): any {
        if (globalState.trackingDerivation && !hasProp(this.target_, key)) {
            // Key doesn't exist yet, subscribe for it in case it's added later
            this.has_(key)
        }
        return this.target_[key]
    }

    /**
     * @param {PropertyKey} key
     * @param {any} value
     * @param {Annotation|boolean} annotation true - infer from descriptor, false - copy as is
     * @param {boolean} proxyTrap whether it's called from proxy trap
     * @returns {boolean|null} true on success, false on failure (proxyTrap + non-configurable), null when cancelled by interceptor
     */
    set_(key: PropertyKey, value: any, proxyTrap: boolean = false): boolean | null {
        // Don't use .has(key) - we care about own
        if (hasProp(this.target_, key)) {
            // Existing prop
            if (this.values_.has(key)) {
                // Observable (can be intercepted)
                return this.setObservablePropValue_(key, value)
            } else if (proxyTrap) {
                // Non-observable - proxy
                return Reflect.set(this.target_, key, value)
            } else {
                // Non-observable
                this.target_[key] = value
                return true
            }
        } else {
            // New prop
            return this.extend_(
                key,
                { value, enumerable: true, writable: true, configurable: true },
                this.defaultAnnotation_,
                proxyTrap
            )
        }
    }

    // Trap for "in"
    has_(key: PropertyKey): boolean {
        if (!globalState.trackingDerivation) {
            // Skip key subscription outside derivation
            return key in this.target_
        }
        this.pendingKeys_ ||= new Map()
        let entry = this.pendingKeys_.get(key)
        if (!entry) {
            entry = new ObservableValue(
                key in this.target_,
                referenceEnhancer,
                __DEV__ ? `${this.name_}.${stringifyKey(key)}?` : "ObservableObject.key?",
                false
            )
            this.pendingKeys_.set(key, entry)
        }
        return entry.get()
    }

    /**
     * @param {PropertyKey} key
     * @param {Annotation|boolean} annotation true - infer from object or it's prototype, false - ignore
     */
    make_(key: PropertyKey, annotation: Annotation | boolean): void {
        if (annotation === true) {
            annotation = this.inferAnnotation_(key)
        }
        // 不转换为观测对象
        if (annotation === false) {
            return
        }
        assertAnnotable(this, annotation, key)
        annotation.make_(this, key)
    }

    /**
     * @param {PropertyKey} key
     * @param {PropertyDescriptor} descriptor
     * @param {Annotation|boolean} annotation true - infer from descriptor, false - copy as is
     * @param {boolean} proxyTrap whether it's called from proxy trap
     * @returns {boolean|null} true on success, false on failure (proxyTrap + non-configurable), null when cancelled by interceptor
     */
     extend_(
        key: PropertyKey,
        descriptor: PropertyDescriptor,
        annotation: Annotation | boolean,
        proxyTrap: boolean = false
    ): boolean | null {
        if (annotation === true) {
            // 根据当前的属性的 descriptor 选择一个最合适装饰器
            annotation = inferAnnotationFromDescriptor(
                descriptor,
                this.defaultAnnotation_,
                this.autoBind_
            )
        }
        if (annotation === false) {
            return this.defineProperty_(key, descriptor, proxyTrap)
        }
        // TODO: 回头读 
        assertAnnotable(this, annotation, key)
        // 实际是调用 当前 adm 实例的 defineObservableProperty_ 方法
         const outcome = annotation.extend_(this, key, descriptor, proxyTrap)
        if (outcome) {
            recordAnnotationApplied(this, annotation, key)
        }
        return outcome
    }
    // 根据给定的 key 推导 该key 的 装饰器 并缓存在 target_的prototype 上
    inferAnnotation_(key: PropertyKey): Annotation | false {
        // Inherited is fine - annotation cannot differ in subclass
        let annotation = this.target_[inferredAnnotationsSymbol]?.get(key)
        if (annotation) return annotation

        let current = this.target_
        while (current && current !== objectPrototype) {
            // 获取 key 的 描述符
            const descriptor = getDescriptor(current, key)
            if (descriptor) {
                annotation = inferAnnotationFromDescriptor(
                    descriptor,
                    this.defaultAnnotation_,
                    this.autoBind_
                )
                break
            }
            current = Object.getPrototypeOf(current)
        }

        // Not found (false means ignore)
        if (annotation === undefined) {
            die(1, "true", key)
        }

        // Cache the annotation.
        // Note we can do this only because annotation and field can't change.
        // 如果不是纯对象 给对象的 prototype 添加 【inferredAnnotationsSymbol 属性
        // 值为一个存放 key 的 annotation  的map
        if (!this.isPlainObject_) {
            // We could also place it on furthest proto, shoudn't matter
            const closestProto = Object.getPrototypeOf(this.target_)
            if (!hasProp(closestProto, inferredAnnotationsSymbol)) {
                addHiddenProp(closestProto, inferredAnnotationsSymbol, new Map())
            }
            closestProto[inferredAnnotationsSymbol].set(key, annotation)
        }

        return annotation
    }

    /**
     * @param {PropertyKey} key
     * @param {PropertyDescriptor} descriptor
     * @param {boolean} proxyTrap whether it's called from proxy trap
     * @returns {boolean|null} true on success, false on failure (proxyTrap + non-configurable), null when cancelled by interceptor
     */
    defineProperty_(
        key: PropertyKey,
        descriptor: PropertyDescriptor,
        proxyTrap: boolean = false
    ): boolean | null {
        try {
            startBatch()

            // Delete
            const deleteOutcome = this.delete_(key)
            if (!deleteOutcome) {
                // Failure or intercepted
                return deleteOutcome
            }

            // ADD interceptor
            if (hasInterceptors(this)) {
                const change = interceptChange<IObjectWillChange>(this, {
                    object: this.proxy_ || this.target_,
                    name: key,
                    type: ADD,
                    newValue: descriptor.value
                })
                if (!change) return null
                const { newValue } = change as any
                if (descriptor.value !== newValue) {
                    descriptor = {
                        ...descriptor,
                        value: newValue
                    }
                }
            }

            // Define
            if (proxyTrap) {
                if (!Reflect.defineProperty(this.target_, key, descriptor)) {
                    return false
                }
            } else {
                defineProperty(this.target_, key, descriptor)
            }

            // Notify
            this.notifyPropertyAddition_(key, descriptor.value)
        } finally {
            endBatch()
        }
        return true
    }

    // If original descriptor becomes relevant, move this to annotation directly
    defineObservableProperty_(
        key: PropertyKey, // 属性的 key
        value: any, // 属性值
        enhancer: IEnhancer<any>,
        proxyTrap: boolean = false
    ): boolean | null {
        try {
            startBatch()
            // 判断当前 _target上是否存在该属性
            // Delete
            const deleteOutcome = this.delete_(key)
            if (!deleteOutcome) {
                // Failure or intercepted
                return deleteOutcome
            }
            // 是否有 Interceptor 
            if (hasInterceptors(this)) {
                const change = interceptChange<IObjectWillChange>(this, {
                    object: this.proxy_ || this.target_,
                    name: key,
                    type: ADD,
                    newValue: value
                })
                if (!change) return null
                value = (change as any).newValue
            }
            // 获取 name 的缓存描述符, 如果没有创建一个
            const cachedDescriptor = getCachedObservablePropDescriptor(key)
            const descriptor = {
                configurable: globalState.safeDescriptors ? this.isPlainObject_ : true,
                enumerable: true,
                get: cachedDescriptor.get,
                set: cachedDescriptor.set
            }
            // 将 name 属性定义在 this.target上
            // Define
            if (proxyTrap) {
                if (!Reflect.defineProperty(this.target_, key, descriptor)) {
                    return false
                }
            } else {
                defineProperty(this.target_, key, descriptor)
            }

            const observable = new ObservableValue(
                value,
                enhancer,
                __DEV__ ? `${this.name_}.${key.toString()}` : "ObservableObject.key",
                false
            )

            this.values_.set(key, observable)

            // Notify (value possibly changed by ObservableValue)
            this.notifyPropertyAddition_(key, observable.value_)
        } finally {
            endBatch()
        }
        return true
    }

    // If original descriptor becomes relevant, move this to annotation directly
    // define Computed value
    defineComputedProperty_(
        key: PropertyKey,
        options: IComputedValueOptions<any>,
        proxyTrap: boolean = false
    ): boolean | null {
        try {
            startBatch()

            // Delete
            const deleteOutcome = this.delete_(key)
            if (!deleteOutcome) {
                // Failure or intercepted
                // 失败或拦截
                return deleteOutcome
            }

            // ADD interceptor
            if (hasInterceptors(this)) {
                const change = interceptChange<IObjectWillChange>(this, {
                    object: this.proxy_ || this.target_,
                    name: key,
                    type: ADD,
                    newValue: undefined
                })
                if (!change) return null
            }
            options.name ||= __DEV__ ? `${this.name_}.${key.toString()}` : "ObservableObject.key"
            options.context = this.proxy_ || this.target_
            const cachedDescriptor = getCachedObservablePropDescriptor(key)
            const descriptor = {
                configurable: globalState.safeDescriptors ? this.isPlainObject_ : true,
                enumerable: false,
                get: cachedDescriptor.get,
                set: cachedDescriptor.set
            }

            // Define
            if (proxyTrap) {
                if (!Reflect.defineProperty(this.target_, key, descriptor)) {
                    return false
                }
            } else {
                defineProperty(this.target_, key, descriptor)
            }

            this.values_.set(key, new ComputedValue(options))

            // Notify
            this.notifyPropertyAddition_(key, undefined)
        } finally {
            endBatch()
        }
        return true
    }

    /**
     * @param {PropertyKey} key
     * @param {PropertyDescriptor} descriptor
     * @param {boolean} proxyTrap whether it's called from proxy trap
     * @returns {boolean|null} true on success, false on failure (proxyTrap + non-configurable), null when cancelled by interceptor
     */
    delete_(key: PropertyKey, proxyTrap: boolean = false): boolean | null {
        // No such prop
        if (!hasProp(this.target_, key)) {
            return true
        }

        // Intercept
        // 被拦截返回 false
        if (hasInterceptors(this)) {
            const change = interceptChange<IObjectWillChange>(this, {
                object: this.proxy_ || this.target_,
                name: key,
                type: REMOVE
            })
            // Cancelled
            if (!change) return null
        }

        // Delete
        try {
            startBatch()
            const notify = hasListeners(this)
            const notifySpy = __DEV__ && isSpyEnabled()
            const observable = this.values_.get(key)
            // Value needed for spies/listeners
            let value = undefined
            // Optimization: don't pull the value unless we will need it
            if (!observable && (notify || notifySpy)) {
                value = getDescriptor(this.target_, key)?.value
            }
            // delete prop (do first, may fail)
            if (proxyTrap) {
                if (!Reflect.deleteProperty(this.target_, key)) {
                    return false
                }
            } else {
                delete this.target_[key]
            }
            // Allow re-annotating this field
            if (__DEV__) {
                delete this.appliedAnnotations_![key]
            }
            // Clear observable
            if (observable) {
                this.values_.delete(key)
                // for computed, value is undefined
                if (observable instanceof ObservableValue) {
                    value = observable.value_
                }
                // Notify: autorun(() => obj[key]), see #1796
                propagateChanged(observable)
            }
            // Notify "keys/entries/values" observers
            this.keysAtom_.reportChanged()

            // Notify "has" observers
            // "in" as it may still exist in proto
            this.pendingKeys_?.get(key)?.set(key in this.target_)

            // Notify spies/listeners
            if (notify || notifySpy) {
                const change: IObjectDidChange = {
                    type: REMOVE,
                    observableKind: "object",
                    object: this.proxy_ || this.target_,
                    debugObjectName: this.name_,
                    oldValue: value,
                    name: key
                }
                if (__DEV__ && notifySpy) spyReportStart(change!)
                if (notify) notifyListeners(this, change)
                if (__DEV__ && notifySpy) spyReportEnd()
            }
        } finally {
            endBatch()
        }
        return true
    }

    /**
     * Observes this object. Triggers for the events 'add', 'update' and 'delete'.
     * See: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/observe
     * for callback details
     */
    observe_(callback: (changes: IObjectDidChange) => void, fireImmediately?: boolean): Lambda {
        if (__DEV__ && fireImmediately === true)
            die("`observe` doesn't support the fire immediately property for observable objects.")
        return registerListener(this, callback)
    }

    intercept_(handler): Lambda {
        return registerInterceptor(this, handler)
    }

    notifyPropertyAddition_(key: PropertyKey, value: any) {
        const notify = hasListeners(this)
        const notifySpy = __DEV__ && isSpyEnabled()
        if (notify || notifySpy) {
            const change: IObjectDidChange | null =
                notify || notifySpy
                    ? ({
                          type: ADD,
                          observableKind: "object",
                          debugObjectName: this.name_,
                          object: this.proxy_ || this.target_,
                          name: key,
                          newValue: value
                      } as const)
                    : null

            if (__DEV__ && notifySpy) spyReportStart(change!)
            if (notify) notifyListeners(this, change)
            if (__DEV__ && notifySpy) spyReportEnd()
        }

        this.pendingKeys_?.get(key)?.set(true)

        // Notify "keys/entries/values" observers
        this.keysAtom_.reportChanged()
    }

    ownKeys_(): PropertyKey[] {
        this.keysAtom_.reportObserved()
        return ownKeys(this.target_)
    }

    keys_(): PropertyKey[] {
        // Returns enumerable && own, but unfortunately keysAtom will report on ANY key change.
        // There is no way to distinguish between Object.keys(object) and Reflect.ownKeys(object) - both are handled by ownKeys trap.
        // We can either over-report in Object.keys(object) or under-report in Reflect.ownKeys(object)
        // We choose to over-report in Object.keys(object), because:
        // - typically it's used with simple data objects
        // - when symbolic/non-enumerable keys are relevant Reflect.ownKeys works as expected
        this.keysAtom_.reportObserved()
        return Object.keys(this.target_)
    }
}

export interface IIsObservableObject {
    $mobx: ObservableObjectAdministration
}
// 为 tatrget 添加一个 $mobx属性值 为  ObservableObjectAdministration 实例
export function asObservableObject(
    target: any,
    options?: CreateObservableOptions
): IIsObservableObject {
    // 如果 options 存在 并且 是被观察对象 
    if (__DEV__ && options && isObservableObject(target)) {
        die(`Options can't be provided for already observable objects.`)
    }
    // 如果 target存在 $mobx 直接返回
    if (hasProp(target, $mobx)) {
        if (__DEV__ && !(getAdministration(target) instanceof ObservableObjectAdministration)) {
            die(
                `Cannot convert '${getDebugName(target)}' into observable object:` +
                    `\nThe target is already observable of different type.` +
                    `\nExtending builtins is not supported.`
            )
        }
        return target
    }
    // 判断对象是否可扩展
    if (__DEV__ && !Object.isExtensible(target))
        die("Cannot make the designated object observable; it is not extensible")
    //  name  = options.name || `${ObservableObject |  target.constructor.name}@1312
    const name =
        options?.name ??
        (__DEV__
            ? `${
                  isPlainObject(target) ? "ObservableObject" : target.constructor.name
              }@${getNextId()}`
            : "ObservableObject")
    // 创建一个 ObservableObjectAdministration 实例
    const adm = new ObservableObjectAdministration(
        target,
        new Map(),
        String(name),
        getAnnotationFromOptions(options),
        options?.autoBind
    )
    // 添加一个 $mobx 默认属性 值为 adm
    addHiddenProp(target, $mobx, adm)
    // 返回 目标对象
    return target
}

const isObservableObjectAdministration = createInstanceofPredicate(
    "ObservableObjectAdministration",
    ObservableObjectAdministration
)

function getCachedObservablePropDescriptor(key) {
    return (
        descriptorCache[key] ||
        (descriptorCache[key] = {
            get() {
                return this[$mobx].getObservablePropValue_(key)
            },
            set(value) {
                return this[$mobx].setObservablePropValue_(key, value)
            }
        })
    )
}
// 判断是否是一个已经是被观察对象
// 如果是被观察对象 对象上会存在 $mobx 属性 该属性是 ObservableObjectAdministration 类的实例对象
export function isObservableObject(thing: any): boolean {
    if (isObject(thing)) {
        return isObservableObjectAdministration((thing as any)[$mobx])
    }
    return false
}

export function recordAnnotationApplied(
    adm: ObservableObjectAdministration,
    annotation: Annotation,
    key: PropertyKey
) {
    if (__DEV__) {
        adm.appliedAnnotations_![key] = annotation
    }
    // Remove applied decorator annotation so we don't try to apply it again in subclass constructor
    // 删除已应用的装饰器注释，这样我们就不会在子类构造函数中再次应用它
    delete adm.target_[storedAnnotationsSymbol]?.[key]
}

function assertAnnotable(
    adm: ObservableObjectAdministration,
    annotation: Annotation,
    key: PropertyKey
) {
    // Valid annotation
    if (__DEV__ && !isAnnotation(annotation)) {
        die(`Cannot annotate '${adm.name_}.${key.toString()}': Invalid annotation.`)
    }

    /*
    // Configurable, not sealed, not frozen
    // Possibly not needed, just a little better error then the one thrown by engine.
    // Cases where this would be useful the most (subclass field initializer) are not interceptable by this.
    if (__DEV__) {
        const configurable = getDescriptor(adm.target_, key)?.configurable
        const frozen = Object.isFrozen(adm.target_)
        const sealed = Object.isSealed(adm.target_)
        if (!configurable || frozen || sealed) {
            const fieldName = `${adm.name_}.${key.toString()}`
            const requestedAnnotationType = annotation.annotationType_
            let error = `Cannot apply '${requestedAnnotationType}' to '${fieldName}':`
            if (frozen) {
                error += `\nObject is frozen.`
            }
            if (sealed) {
                error += `\nObject is sealed.`
            }
            if (!configurable) {
                error += `\nproperty is not configurable.`
                // Mention only if caused by us to avoid confusion
                if (hasProp(adm.appliedAnnotations!, key)) {
                    error += `\nTo prevent accidental re-definition of a field by a subclass, `
                    error += `all annotated fields of non-plain objects (classes) are not configurable.`
                }
            }
            die(error)
        }
    }
    */

    // Not annotated
    if (__DEV__ && !isOverride(annotation) && hasProp(adm.appliedAnnotations_!, key)) {
        const fieldName = `${adm.name_}.${key.toString()}`
        const currentAnnotationType = adm.appliedAnnotations_![key].annotationType_
        const requestedAnnotationType = annotation.annotationType_
        die(
            `Cannot apply '${requestedAnnotationType}' to '${fieldName}':` +
                `\nThe field is already annotated with '${currentAnnotationType}'.` +
                `\nRe-annotating fields is not allowed.` +
                `\nUse 'override' annotation for methods overriden by subclass.`
        )
    }
}
