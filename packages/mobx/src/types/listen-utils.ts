import { Lambda, once, untrackedEnd, untrackedStart } from "../internal"

export interface IListenable {
    changeListeners_: Function[] | undefined
}
// 是否含有 listener
export function hasListeners(listenable: IListenable) {
    return listenable.changeListeners_ !== undefined && listenable.changeListeners_.length > 0
}

export function registerListener(listenable: IListenable, handler: Function): Lambda {
    const listeners = listenable.changeListeners_ || (listenable.changeListeners_ = [])
    listeners.push(handler)
    return once(() => {
        const idx = listeners.indexOf(handler)
        if (idx !== -1) listeners.splice(idx, 1)
    })
}
// 触发listener
export function notifyListeners<T>(listenable: IListenable, change: T) {
    // 标识开始
    const prevU = untrackedStart()
    // 监听列表
    let listeners = listenable.changeListeners_
    if (!listeners) return
    listeners = listeners.slice()
    // 执行监听列表
    for (let i = 0, l = listeners.length; i < l; i++) {
        listeners[i](change)
    }
    // 标识结束
    untrackedEnd(prevU)
}
