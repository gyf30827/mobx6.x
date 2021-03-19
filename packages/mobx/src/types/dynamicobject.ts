import {
    $mobx,
    IIsObservableObject,
    ObservableObjectAdministration,
    warnAboutProxyRequirement,
    assertProxies,
    die,
    isStringish,
    globalState,
    CreateObservableOptions,
    asObservableObject
} from "../internal"
// 返回目标对象的$mobx
function getAdm(target): ObservableObjectAdministration {
    return target[$mobx]
}

// Optimization: we don't need the intermediate objects and could have a completely custom administration for DynamicObjects,
// and skip either the internal values map, or the base object with its property descriptors!
const objectProxyTraps: ProxyHandler<any> = {
    has(target: IIsObservableObject, name: PropertyKey): boolean {
        if (__DEV__ && globalState.trackingDerivation)
            warnAboutProxyRequirement(
                "detect new properties using the 'in' operator. Use 'has' from 'mobx' instead."
            )
        return getAdm(target).has_(name)
    },
    get(target: IIsObservableObject, name: PropertyKey): any {
        return getAdm(target).get_(name)
    },
    set(target: IIsObservableObject, name: PropertyKey, value: any): boolean {
        if (!isStringish(name)) return false
        if (__DEV__ && !getAdm(target).values_.has(name)) {
            warnAboutProxyRequirement(
                "add a new observable property through direct assignment. Use 'set' from 'mobx' instead."
            )
        }
        // null (intercepted) -> true (success)
        return getAdm(target).set_(name, value, true) ?? true
    },
    deleteProperty(target: IIsObservableObject, name: PropertyKey): boolean {
        if (__DEV__) {
            warnAboutProxyRequirement(
                "delete properties from an observable object. Use 'remove' from 'mobx' instead."
            )
        }
        if (!isStringish(name)) return false
        // null (intercepted) -> true (success)
        return getAdm(target).delete_(name, true) ?? true
    },
    defineProperty(
        target: IIsObservableObject,
        name: PropertyKey,
        descriptor: PropertyDescriptor
    ): boolean {
        if (__DEV__) {
            warnAboutProxyRequirement(
                "define property on an observable object. Use 'defineProperty' from 'mobx' instead."
            )
        }
        // null (intercepted) -> true (success)
        return getAdm(target).defineProperty_(name, descriptor) ?? true
    },
    ownKeys(target: IIsObservableObject): PropertyKey[] {
        if (__DEV__ && globalState.trackingDerivation)
            warnAboutProxyRequirement(
                "iterate keys to detect added / removed properties. Use `keys` from 'mobx' instead."
            )
        return getAdm(target).ownKeys_()
    },
    preventExtensions(target) {
        die(13)
    }
}
// 为 targert $mobx 属性， 属性值为一个 adm 对象的 
// 为 target[$mobx]添加 proxy_ 属性，值为 target 创建的 Proxy 实例 
export function asDynamicObservableObject(
    target: any,
    options?: CreateObservableOptions
): IIsObservableObject {
    assertProxies()
    // 一个包含 $mobx 属性， 属性值为一个 adm 对象的
    target = asObservableObject(target, options);
    // target[$mobx].proxy_ 不等于 null 返回 target[$mobx].proxy_ 
    // 等于 null new 一个proxxy 并返回
    return (target[$mobx].proxy_ ??= new Proxy(target, objectProxyTraps))
}
