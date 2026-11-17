// TIDELOCK UI kit — the interface design system. One import for everything:
//
//   import { createRoot, h, Panel, Button, DataTable, LineChart, toast, icon } from '../kit';
//
//   kit.ts         DOM builder, signals, gestures, scrolling, motion, style injection
//   icons.ts       thin-line icon set, wordmark, emblem, comms portraits
//   components.ts  in-flow components (panel, header, buttons, inputs, lists, table, gauges…)
//   charts.ts      canvas sparkline / line / area / bar charts
//   overlays.ts    modal, bottom sheet, toasts, help popover, comms message, splash
//
// Styles (tokens.css + components.css) are injected once by installStyles(), which createRoot() calls.

export * from './kit';
export * from './icons';
export * from './components';
export * from './charts';
export * from './overlays';
