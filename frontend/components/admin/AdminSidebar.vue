<script setup lang="ts">
import {
  Activity,
  Layers,
  Database,
  Network,
  FolderSearch,
  Flame,
  Users,
  ScrollText,
  Settings2,
  Search,
  ArrowUpRight,
  ChevronsUpDown,
  LogOut,
  ShieldCheck,
} from "@lucide/vue";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { adminNavigation } from "./navigation";
import { useAdminSession } from "@/composables/admin/useAdminSession";
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
  SidebarFooter,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
const route = useRoute();
const { user, logout } = useAdminSession();
const { setOpenMobile, isMobile } = useSidebar();
const icons = {
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
          ><SidebarMenuButton size="lg" as-child tooltip="pansou 管理后台">
            <RouterLink
              to="/admin/monitor"
              class="admin-brand"
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
                :is-active="route.path === item.path"
                :tooltip="item.title"
              >
                <RouterLink
                  :to="item.path"
                  :aria-current="route.path === item.path ? 'page' : undefined"
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
    <SidebarFooter>
      <SidebarMenu
        ><SidebarMenuItem
          ><SidebarMenuButton as-child tooltip="返回搜索首页"
            ><RouterLink to="/"
              ><ArrowUpRight /><span>返回搜索首页</span></RouterLink
            ></SidebarMenuButton
          ></SidebarMenuItem
        >
        <SidebarMenuItem
          ><DropdownMenu
            ><DropdownMenuTrigger as-child
              ><SidebarMenuButton
                size="lg"
                class="admin-account"
                :tooltip="user?.username || '管理员'"
              >
                <span class="admin-avatar"><ShieldCheck :size="18" /></span
                ><span class="admin-account-copy"
                  ><strong>{{
                    user?.nickname || user?.username || "管理员"
                  }}</strong
                  ><small>管理员</small></span
                ><ChevronsUpDown
                  class="tw:ml-auto"
                /> </SidebarMenuButton></DropdownMenuTrigger
            ><DropdownMenuContent side="top" align="end" class="tw:min-w-56"
              ><DropdownMenuLabel>{{ user?.username }}</DropdownMenuLabel
              ><DropdownMenuSeparator /><DropdownMenuItem @select="logout"
                ><LogOut />退出后台</DropdownMenuItem
              ></DropdownMenuContent
            ></DropdownMenu
          ></SidebarMenuItem
        ></SidebarMenu
      > </SidebarFooter
    ><SidebarRail />
  </Sidebar>
</template>
