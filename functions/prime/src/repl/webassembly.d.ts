// The slice of the WebAssembly JS API the REPL driver uses. Node provides the
// global at runtime, but @types/node doesn't declare it and the shared
// tsconfig has no DOM lib, so declare it here rather than widen `lib` for
// every package.

declare namespace WebAssembly {
  type ExportValue = Function | Global | Memory | Table;
  type Exports = Record<string, ExportValue>;
  type ImportValue = ExportValue | number | bigint;
  type Imports = Record<string, Record<string, ImportValue | ((...args: never[]) => unknown)>>;

  interface Global { value: unknown }
  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  interface Table {
    readonly length: number;
    get(index: number): unknown;
    grow(delta: number, value?: unknown): number;
    set(index: number, value?: unknown): void;
  }
  interface Instance { readonly exports: Exports }
  interface Module {}
  interface WebAssemblyInstantiatedSource {
    instance: Instance;
    module: Module;
  }

  function instantiate(bytes: BufferSource, imports?: Imports): Promise<WebAssemblyInstantiatedSource>;
}

type BufferSource = ArrayBufferView | ArrayBuffer;
