<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import { ChevronRight } from "@lucide/vue";
import AdminAccessGate from "./AdminAccessGate.vue";
import AdminSidebar from "./AdminSidebar.vue";
import AdminHeaderActions from "./AdminHeaderActions.vue";
import AdminConfirmDialog from "./AdminConfirmDialog.vue";
import { provideAdminConfirm } from "@/composables/admin/useAdminConfirm";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { Separator } from "./ui/separator";
import { provideAdminSession } from "@/composables/admin/useAdminSession";
import { adminNavigation } from "./navigation";
import "../../assets/admin.css";
const session = provideAdminSession();
const confirmation = provideAdminConfirm();
const { checking, locked, authenticated, error } = session;
const route = useRoute();
const current = computed(() =>
  adminNavigation.find((item) => item.path === (route.path === '/admin/link-cleanup' ? '/admin/tasks' : route.path)),
);
watch(
  () => route.fullPath,
  () => confirmation.answer(false),
);
onMounted(session.check);
</script>
<template>
  <div class="admin-root">
    <AdminAccessGate
      v-if="checking || locked"
      :checking="checking"
      :authenticated="authenticated"
      :error="error"
      @authenticated="session.check"
    />
    <SidebarProvider v-else
      ><AdminSidebar /><SidebarInset>
        <header class="admin-topbar">
          <div class="admin-breadcrumb">
            <SidebarTrigger aria-label="切换后台侧栏" /><Separator
              orientation="vertical"
              class="tw:h-4"
            /><span class="admin-breadcrumb-root">管理后台</span><ChevronRight class="admin-breadcrumb-divider" :size="14" /><strong :title="current?.title || '管理后台'">{{
              current?.title || "管理后台"
            }}</strong>
          </div>
          <AdminHeaderActions />
        </header>
        <section class="admin-main">
          <RouterView />
        </section> </SidebarInset
    ></SidebarProvider>
    <AdminConfirmDialog />
  </div>
  <div id="admin-portals" class="admin-root admin-portals" />
</template>
