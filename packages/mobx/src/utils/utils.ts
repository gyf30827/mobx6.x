import { globalState, die } from "../internal"

// We shorten anything used > 5 times
export const assign = Object.assign
export const getDescriptor = Object.getOwnPropertyDescriptor
export const defineProperty = Object.defineProperty
export const objectPrototype = Object.prototype

export const EMPTY_ARRAY = []
Object.freeze(EMPTY_ARRAY)

export const EMPTY_OBJECT = {}
Object.freeze(EMPTY_OBJECT)

export interface Lambda {
    (): void
    name?: string
}

const hasProxy = typeof Proxy !== "undefined"
const plainObjectString = Object.toString()

// 检查当前环境是否支持proxy
export function assertProxies() {
    if (!hasProxy) {
        die(
            __DEV__
                ? "`Proxy` objects are not available in the current environment. Please configure MobX to enable a fallback implementation.`"
                : "Proxy not available"
        )
    }
}

export function warnAboutProxyRequirement(msg: string) {
    if (__DEV__ && globalState.verifyProxies) {
        die(
            "MobX is currently configured to be able to run in ES5 mode, but in ES5 MobX won't be able to " +
                msg
        )
    }
}
// 获取唯一id 每次获取做  ++ 处理 从 0开始
export function getNextId() {
    return ++globalState.mobxGuid
}

/**
 * Makes sure that the provided function is invoked at most once.
 */
export function once(func: Lambda): Lambda {
    let invoked = false
    return function () {
        if (invoked) return
        invoked = true
        return (func as any).apply(this, arguments)
    }
}

export const noop = () => {}

export function isFunction(fn: any): fn is Function {
    return typeof fn === "function"
}

export function isString(value: any): value is string {
    return typeof value === "string"
}
// 如果是string | synbox | number 返回 true 否则返回false
export function isStringish(value: any): value is string | number | symbol {
    const t = typeof value
    switch (t) {
        case "string":
        case "symbol":
        case "number":
            return true
    }
    return false
}
// 判断是否为一个对象
export function isObject(value: any): value is Object {
    return value !== null && typeof value === "object"
}
// 判断对象是否是一个没有原型的对象
export function isPlainObject(value) {
    if (!isObject(value)) return false
    const proto = Object.getPrototypeOf(value)
    if (proto == null) return true
    return proto.constructor?.toString() === plainObjectString
}

// https://stackoverflow.com/a/37865170
export function isGenerator(obj: any): boolean {
    const constructor = obj?.constructor
    if (!constructor) return false
    if ("GeneratorFunction" === constructor.name || "GeneratorFunction" === constructor.displayName)
        return true
    return false
}
// 添加一个隐藏的属性 
export function addHiddenProp(object: any, propName: PropertyKey, value: any) {
    defineProperty(object, propName, {
        // 不可遍历是否可遍历
        enumerable: false,
        // 是否可修改
        writable: true,
        // 是否可以配置
        configurable: true,
        value
    })
}

export function addHiddenFinalProp(object: any, propName: PropertyKey, value: any) {
    defineProperty(object, propName, {
        enumerable: false,
        writable: false,
        configurable: true,
        value
    })
}
// 返回一个判断某个对象是否属于某一个类的函数
// 给类的的原型链加上 isMobX + name 的属性
// 判断对象的原型上是否有这个属性并且为true
// name 类的唯一标识 theClass 类  
export function createInstanceofPredicate<T>(
    name: string,
    theClass: new (...args: any[]) => T
): (x: any) => x is T {
    const propName = "isMobX" + name
    theClass.prototype[propName] = true
    return function (x) {
        return isObject(x) && x[propName] === true
    } as any
}

export function isES6Map(thing): boolean {
    return thing instanceof Map
}

export function isES6Set(thing): thing is Set<any> {
    return thing instanceof Set
}

const hasGetOwnPropertySymbols = typeof Object.getOwnPropertySymbols !== "undefined"

/**
 * Returns the following: own enumerable keys and symbols.
 */
export function getPlainObjectKeys(object) {
    const keys = Object.keys(object)
    // Not supported in IE, so there are not going to be symbol props anyway...
    if (!hasGetOwnPropertySymbols) return keys
    const symbols = Object.getOwnPropertySymbols(object)
    if (!symbols.length) return keys
    return [...keys, ...symbols.filter(s => objectPrototype.propertyIsEnumerable.call(object, s))]
}

// From Immer utils
// Returns all own keys, including non-enumerable and symbolic
// 返回对象的所有属性的健组成的数组
export const ownKeys: (target: any) => PropertyKey[] =
    typeof Reflect !== "undefined" && Reflect.ownKeys
        ? Reflect.ownKeys
        : hasGetOwnPropertySymbols
        ? obj => Object.getOwnPropertyNames(obj).concat(Object.getOwnPropertySymbols(obj) as any)
        : /* istanbul ignore next */ Object.getOwnPropertyNames

export function stringifyKey(key: any): string {
    if (typeof key === "string") return key
    if (typeof key === "symbol") return key.toString()
    return new String(key).toString()
}

export function toPrimitive(value) {
    return value === null ? null : typeof value === "object" ? "" + value : value
}
// 是否存在某属性
export function hasProp(target: Object, prop: PropertyKey): boolean {
    return objectPrototype.hasOwnProperty.call(target, prop)
}

// 获取自身属性描述符
// From Immer utils
export const getOwnPropertyDescriptors =
    Object.getOwnPropertyDescriptors ||
    function getOwnPropertyDescriptors(target: any) {
        // Polyfill needed for Hermes and IE, see https://github.com/facebook/hermes/issues/274
        const res: any = {}
        // Note: without polyfill for ownKeys, symbols won't be picked up
        ownKeys(target).forEach(key => {
            res[key] = getDescriptor(target, key)
        })
        return res
    }
