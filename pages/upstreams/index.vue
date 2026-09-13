<script setup lang="ts">
// 管理控制台已迁移到 /admin；此路由仅做重定向兼容旧链接。
const query = useRoute().query;
await navigateTo({ path: "/admin", query }, { replace: true });
</script>

<template>
  <div />
</template>
