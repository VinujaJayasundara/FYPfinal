/**
 * Single entry point to MapLibre for the whole app.
 *
 * The package ships separate builds for `import` and `require()`. Loading
 * both registers the native views twice ("Tried to register two views with
 * the same name"), so every file reaches MapLibre through this module, which
 * uses `import` only. Load it lazily (require('./maplibre')) and only when
 * the native module exists.
 */
export * from '@maplibre/maplibre-react-native';
