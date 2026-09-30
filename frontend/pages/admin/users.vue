<template><AdminFeaturePage feature="users" /></template>
<script setup lang="ts">
import { setDocumentHead } from "../../src/appRuntime";

import AdminFeaturePage from "../../components/admin/AdminFeaturePage.vue";
setDocumentHead({ title: "用户管理 - pansou" });
</script>
