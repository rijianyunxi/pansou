<script setup lang="ts">
import MonitorPanel from '../../components/monitor/MonitorPanel.vue';
import { useAdminSession } from '../../composables/admin/useAdminSession';
import { setDocumentHead } from '../../src/appRuntime';
const { locked } = useAdminSession();
setDocumentHead({ title: '运行监控 - pansou' });
</script>
<template><MonitorPanel @unauthorized="locked = true" /></template>
