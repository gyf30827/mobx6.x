import {
    deepEqual,
    isES6Map,
    isES6Set,
    isObservable,
    isObservableArray,
    isObservableMap,
    isObservableSet,
    isObservableObject,
    isPlainObject,
    observable,
    die
} from "../internal"

export interface IEnhancer<T> {
    (newValue: T, oldValue: T | undefined, name: string): T
}
// 
export function deepEnhancer(v, _, name) {
    // it is an observable already, done
    if (isObservable(v)) return v

    // something that can be converted and mutated?
    if (Array.isArray(v)) return observable.array(v, { name })
    if (isPlainObject(v)) return observable.object(v, undefined, { name })
    if (isES6Map(v)) return observable.map(v, { name })
    if (isES6Set(v)) return observable.set(v, { name })

    return v
}
// 只将指定的属性装换为 observable 其余子属性均不转换
export function shallowEnhancer(v, _, name): any {
    if (v === undefined || v === null) return v
    if (isObservableObject(v) || isObservableArray(v) || isObservableMap(v) || isObservableSet(v))
        return v
    if (Array.isArray(v)) return observable.array(v, { name, deep: false })
    if (isPlainObject(v)) return observable.object(v, undefined, { name, deep: false })
    if (isES6Map(v)) return observable.map(v, { name, deep: false })
    if (isES6Set(v)) return observable.set(v, { name, deep: false })

    if (__DEV__)
        die(
            "The shallow modifier / decorator can only used in combination with arrays, objects, maps and sets"
        )
}
// 不进行observable 装换，直接创建一个引用
export function referenceEnhancer(newValue?) {
    // never turn into an observable
    return newValue
}
// 基本同 ref ,会忽略掉结构上相等的新值
export function refStructEnhancer(v, oldValue): any {
    if (__DEV__ && isObservable(v))
        die(`observable.struct should not be used with observable values`)
    if (deepEqual(v, oldValue)) return oldValue
    return v
}
