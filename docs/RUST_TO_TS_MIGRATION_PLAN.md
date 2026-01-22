# План миграции Rust → TypeScript (WASM → чистый TS)

Ниже: пошаговый план и список конкретных точек входа, которые нужно переписать.

---

## 1) Картина зависимости сейчас

- Frontend (`voxellaneous-web`) импортирует WASM пакет `voxellaneous-core` и использует его `Renderer`.
- `voxellaneous-core` — Rust‑ядро рендера с WebGPU (`wgpu`), собирается `wasm-pack`.
- Главная точка входа фронта — `voxellaneous-web/src/main.ts`.

Цель миграции: убрать Rust/WASM, перенести рендер‑логику в TS (WebGPU или другой backend), оставить единый TS‑проект.

---

## 2) Конкретные точки входа, которые надо переписать (минимум)

### В `voxellaneous-web`
1) `voxellaneous-web/src/main.ts`
   - Сейчас:
     - `import init, { Renderer } from 'voxellaneous-core';`
     - `await init({});`
     - `const renderer = await Renderer.new(canvas);`
     - `renderer.upload_scene(scene);`
     - `renderer.render(...)` и `renderer.resize(...)`
   - Нужно заменить на чисто TS‑реализацию рендера.

2) `voxellaneous-web/src/scene.ts`
   - Интерфейс `Scene` используется как контракт данных между TS и Rust.
   - Его нужно сохранить/адаптировать под новый TS‑рендер.

3) `voxellaneous-web/src/renderer/editor.ts`
   - UI‑инструменты для переключения рендера/буферов завязаны на `Renderer` (presentTarget и т.п.).
   - Привязки/типы нужно обновить под новый TS‑renderer.

4) `voxellaneous-web/package.json`
   - Удалить зависимость `"voxellaneous-core": "file:../voxellaneous-core/pkg"`.


### В `voxellaneous-core` (наследуемая логика)
То, что нужно переписать в TS (функционально):

1) `voxellaneous-core/src/lib.rs`
   - Здесь фактически весь рендер:
     - Инициализация WebGPU устройства
     - Создание пайплайнов и буферов
     - `Renderer::new(...)`
     - `Renderer::render(...)`
     - `Renderer::upload_scene(...)`
     - `Renderer::resize(...)`
   - В TS это станет `Renderer` класс/модуль.

2) `voxellaneous-core/src/scene.rs`
   - Типы сцены Rust (соответствие `voxellaneous-web/src/scene.ts`).
   - Нужно портировать логику загрузки данных сцены (палитра, воксели).

3) `voxellaneous-core/src/shaders/*.wgsl`
   - Шейдеры сохраняются (они уже WebGPU/WGSL).
   - Их можно оставить как есть, но перенести загрузку/компиляцию в TS.

---

## 3) План миграции (рекомендованная последовательность)

### Этап 0 — подготовка
- Зафиксировать текущую версию и точку запуска (что сейчас работает).
- Убедиться, что `voxellaneous-web` запускается и рендерит сцену.

### Этап 1 — разрыв зависимости от Rust
- Удалить wasm‑инициализацию из `main.ts`.
- Ввести временный TS‑Renderer с тем же API:
  - `new(canvas)`
  - `render(mvp, cameraPos, presentTarget)`
  - `resize(w, h)`
  - `upload_scene(scene)`
- На этом этапе он может быть “пустышкой”, лишь бы приложение запускалось без Rust.

### Этап 2 — порт рендера на TS WebGPU
- Реализовать инициализацию WebGPU в TS.
- Перенести:
  - создание surface/context
  - пайплайны
  - буферы
  - загрузку шейдеров WGSL
- Запустить минимальный pass (например, full‑screen quad) — проверить, что рендер вообще работает.

### Этап 3 — порт логики сцены
- Перенести `upload_scene`:
  - загрузка палитры
  - загрузка 3D‑текстур вокселей
- Важно: учесть требования `bytes_per_row` и правильный padding.

### Этап 4 — полноценный рендер
- Перенести логику render‑цикла из Rust:
  - G‑Buffer passes
  - present‑pass
- Привести поведение к текущему виду.

### Этап 5 — чистка репозитория
- Удалить `voxellaneous-core/` полностью (или архивировать).
- Удалить все упоминания `wasm-pack` в инструкциях.
- Убедиться, что нет ссылок на `voxellaneous-core/pkg`.

---

## 4) Конкретные участки API, которые нужно сохранить (или заменить)

Сейчас фронт ожидает такие методы/сигнатуры:

- `Renderer.new(canvas: HTMLCanvasElement): Promise<Renderer>`
- `renderer.render(mvp: Float32Array, cameraPos: Float32Array, presentTarget: number): void`
- `renderer.resize(width: number, height: number): void`
- `renderer.upload_scene(scene: Scene): void`

В TS‑версии можно сохранить эти сигнатуры, чтобы не переписывать фронт.

---

## 5) Быстрый список файлов, которые трогаем

- `voxellaneous-web/src/main.ts` — убрать wasm‑инициализацию, подключить TS‑renderer
- `voxellaneous-web/src/scene.ts` — оставить/адаптировать интерфейсы сцены
- `voxellaneous-web/src/renderer/*` — часть логики UI зависит от Renderer
- `voxellaneous-web/package.json` — убрать wasm‑зависимость

- `voxellaneous-core/src/lib.rs` — функционально переписать в TS
- `voxellaneous-core/src/scene.rs` — типы/структуры сцены
- `voxellaneous-core/src/shaders/*.wgsl` — использовать в TS

---

## 6) Предлагаемая новая структура TS‑рендера

```
voxellaneous-web/src/renderer/
  Renderer.ts
  gpu/
    device.ts
    pipelines.ts
    textures.ts
    buffers.ts
  shaders/
    shader.wgsl
    quad_uint.wgsl
    quad_float.wgsl
```

---

Если хочешь, могу:
- уточнить список точек входа после глубокого просмотра кода;
- подготовить skeleton TS‑Renderer с WebGPU;
- начать перенос по шагам.

