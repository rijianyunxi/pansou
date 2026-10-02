<script setup lang="ts">
import {
  Activity,
  Cloud,
  Layers,
  Database,
  Network,
  FolderSearch,
  Flame,
  Users,
  ScrollText,
  Settings2,
  Search,
} from "@lucide/vue";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { adminNavigation } from "./navigation";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar";
const route = useRoute();
const activePath = computed(() => route.path === '/admin/link-cleanup' ? '/admin/tasks' : route.path);
const { setOpenMobile, isMobile } = useSidebar();
const icons = {
  cloud: Cloud,
  activity: Activity,
  layers: Layers,
  database: Database,
  network: Network,
  folder: FolderSearch,
  flame: Flame,
  users: Users,
  logs: ScrollText,
  settings: Settings2,
};
const groups = computed(() =>
  [...new Set(adminNavigation.map((item) => item.group))].map((title) => ({
    title,
    items: adminNavigation.filter((item) => item.group === title),
  })),
);
function navigated() {
  if (isMobile.value) setOpenMobile(false);
}
</script>
<template>
  <Sidebar collapsible="icon" class="admin-sidebar">
    <SidebarHeader>
      <SidebarMenu
        ><SidebarMenuItem
          ><SidebarMenuButton size="lg" as-child tooltip="返回搜索首页">
            <RouterLink
              to="/"
              class="admin-brand"
              aria-label="pansou，返回搜索首页"
              @click="navigated"
            >
              <span class="admin-brand-mark"><Search :size="19" /></span>
              <span class="admin-brand-copy"
                ><strong>pansou</strong><small>管理控制台</small></span
              >
            </RouterLink>
          </SidebarMenuButton></SidebarMenuItem
        ></SidebarMenu
      >
    </SidebarHeader>
    <SidebarContent
      ><SidebarGroup v-for="group in groups" :key="group.title">
        <SidebarGroupLabel>{{ group.title }}</SidebarGroupLabel>
        <SidebarGroupContent
          ><SidebarMenu aria-label="后台导航"
            ><SidebarMenuItem v-for="item in group.items" :key="item.path">
              <SidebarMenuButton
                as-child
                :is-active="activePath === item.path"
                :tooltip="item.title"
              >
                <RouterLink
                  :to="item.path"
                  :aria-current="activePath === item.path ? 'page' : undefined"
                  @click="navigated"
                  ><component :is="icons[item.icon]" /><span>{{
                    item.title
                  }}</span></RouterLink
                >
              </SidebarMenuButton>
            </SidebarMenuItem></SidebarMenu
          ></SidebarGroupContent
        >
      </SidebarGroup></SidebarContent
    >
    <SidebarRail />
  </Sidebar>
</template>
