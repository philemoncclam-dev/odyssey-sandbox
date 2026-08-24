import '@testing-library/jest-dom'

// jsdom implements no layout, so these three are absent. The canvas is
// hand-rolled SVG and reads getBBox when measuring; ResizeObserver and
// DOMMatrixReadOnly are read by panel and transform code on mount.
// Guarded so a real implementation (if jsdom ever adds one) is never clobbered.

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}

if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  class DOMMatrixReadOnlyMock {
    m22: number
    m11: number
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([\d.]+)/)?.[1]
      this.m22 = scale ? parseFloat(scale) : 1
      this.m11 = scale ? parseFloat(scale) : 1
    }
  }
  globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyMock as unknown as typeof DOMMatrixReadOnly
}

if (typeof SVGGraphicsElement.prototype.getBBox === 'undefined') {
  SVGGraphicsElement.prototype.getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0, toJSON: () => '' }) as DOMRect
}
