import ElectrobunEvent from './event';

export default {
    willNavigate: (data) => new ElectrobunEvent<{url: string, windowId: number}, {allow: boolean}>('will-navigate', data),    
}