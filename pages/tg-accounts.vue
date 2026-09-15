<script setup lang="ts">
// Telegram 账户旧入口，统一跳转到带语义路径的管理后台页面。
await navigateTo("/admin/accounts", { replace: true });
</script>
<template><div /></template>
