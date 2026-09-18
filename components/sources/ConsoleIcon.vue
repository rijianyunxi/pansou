<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(path, i) in paths[name] || paths.box" :key="i" :d="path" />
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
const paths: Record<string, string[]> = {
  channel: ["m21 3-6 18-4-8-8-4 18-6Z M11 13 21 3"],
  box: ["M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01 M12 7h5 M12 17h5"],
  database: ["M4 5c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2Z", "M4 5v7c0 1.1 3.6 2 8 2s8-.9 8-2V5", "M4 12v7c0 1.1 3.6 2 8 2s8-.9 8-2v-7"],
  grid: ["M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z"],
  activity: ["M2 12h5l3-8 4 16 3-8h5"],
  arrow: ["M5 12h14 M13 6l6 6-6 6"],
  back: ["M19 12H5 M11 6l-6 6 6 6"],
  plus: ["M12 5v14 M5 12h14"],
  search: ["M20 20l-5-5", "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0"],
  chevron: ["M9 5l7 7-7 7"],
  down: ["m6 9 6 6 6-6"],
  code: ["m8 5-6 7 6 7 M16 5l6 7-6 7 M14 3l-4 18"],
  map: ["M5 4h5v5H5z M14 15h5v5h-5z M7.5 9v8.5H14 M14 4h5v5h-5z M10 6.5h4"],
  play: ["m8 5 11 7-11 7z"],
  check: ["m5 12 4 4L19 6"],
  circle: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2"],
  close: ["m6 6 12 12 M18 6 6 18"],
  info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7h.01"],
  refresh: [
    "M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 3 M19 16a8 8 0 0 1-13 3l-2-3",
  ],
  edit: ["m15 4 5 5 M4 20l5-1L21 7l-5-5L4 14z"],
  copy: ["M8 8h12v13H8z M16 8V3H3v13h5"],
  shield: ["m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6"],
  external: ["M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7"],
  upload: ["M12 16V4 M7 9l5-5 5 5 M4 20h16"],
  download: ["M12 4v12 M7 11l5 5 5-5 M4 20h16"],
  trash: ["M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"],
  stop: ["M6 6h12v12H6z"],
  lock: ["M6 10V8a6 6 0 0 1 12 0v2 M5 10h14v11H5z M12 14v3"],
  unlock: ["M8 10V8a5 5 0 0 1 9-3 M5 10h14v11H5z M12 14v3"],
  key: ["M15 7a5 5 0 1 1-3.5 8.5L3 21v-4l2-2h3l1.5-1.5 M15 7h.01"],
  user: ["M20 21a8 8 0 0 0-16 0 M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8"],
  logout: ["M10 17l5-5-5-5 M15 12H3 M14 3h6v18h-6"],
  archive: ["M4 7h16v14H4z M3 3h18v4H3z M9 11h6"],
  restore: ["M4 7v5h5 M5 11a8 8 0 1 1 2 7"],
  globe: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18 M12 3c-5 5-5 13 0 18",
  ],
  sliders: [
    "M4 6h9 M13 4v4 M17 6h3 M4 12h3 M7 10v4 M11 12h9 M4 18h11 M17 16v4 M21 18h.01",
  ],
};
</script>
