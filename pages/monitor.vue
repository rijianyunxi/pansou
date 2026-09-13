<script setup lang="ts">
// 健康监控已并入管理控制台（/admin?view=monitor）；此路由仅做重定向兼容旧链接。
await navigateTo("/admin?view=monitor", { replace: true });
</script>

<template>
  <div />
</template>
