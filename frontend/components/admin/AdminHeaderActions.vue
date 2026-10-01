<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown, LogOut, ShieldCheck } from "@lucide/vue";
import { useAdminSession } from "@/composables/admin/useAdminSession";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "./ui/dropdown-menu";

const { user, logout } = useAdminSession();
const name = computed(() => user.value?.nickname || user.value?.username || "管理员");
</script>

<template>
  <div class="admin-header-actions">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" class="admin-header-account" :aria-label="`${name}，管理员菜单`" :title="name">
          <ShieldCheck :size="16" aria-hidden="true" />
          <span class="admin-header-account-name">{{ name }}</span>
          <ChevronDown :size="14" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" class="tw:min-w-48">
        <DropdownMenuLabel>{{ user?.username || name }}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="logout"><LogOut />退出后台</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
