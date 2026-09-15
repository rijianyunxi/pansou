<script setup lang="ts">
// 来源管理旧入口，兼容历史 view 查询参数并迁移到路径路由。
const query = useRoute().query;
const legacyView = typeof query.view === "string" ? query.view : "";
const target = legacyView === "monitor" || legacyView === "settings"
  ? "/admin/monitor"
  : legacyView === "accounts"
    ? "/admin/accounts"
    : legacyView === "telegram"
      ? "/admin/telegram"
      : "/admin/sources";
const nextQuery = { ...query };
delete nextQuery.view;
await navigateTo({ path: target, query: nextQuery }, { replace: true });
</script>
<template><div /></template>
