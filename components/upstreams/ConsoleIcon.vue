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
  box: ["M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01 M12 7h5 M12 17h5"],
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
  trash: ["M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"],
  stop: ["M6 6h12v12H6z"],
  globe: [
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18 M12 3c-5 5-5 13 0 18",
  ],
};
</script>
