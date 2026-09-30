<template>
  <ProxyNodesPage />
</template>

<script setup lang="ts">
import { setDocumentHead } from "../../src/appRuntime";

import ProxyNodesPage from "../../components/admin/ProxyNodesPage.vue";
setDocumentHead({ title: "代理节点 - pansou" });
</script>
