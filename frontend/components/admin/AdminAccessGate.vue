<script setup lang="ts">
import { ref } from "vue";
import { RouterLink } from "vue-router";
import { Search, ShieldCheck, LoaderCircle, ArrowLeft } from "@lucide/vue";
import { useAuth } from "@/composables/useAuth";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";
const props = withDefaults(
  defineProps<{
    checking?: boolean;
    authenticated?: boolean;
    error?: string;
    title?: string;
  }>(),
  { checking: false, authenticated: false, error: "", title: "登录管理后台" },
);
const emit = defineEmits<{ authenticated: [] }>();
const auth = useAuth();
const username = ref(""),
  password = ref(""),
  busy = ref(false);
async function submit() {
  if (busy.value) return;
  busy.value = true;
  try {
    const user = await auth.login(username.value, password.value);
    if (user?.role === "admin") {
      password.value = "";
      emit("authenticated");
    }
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="admin-login" :aria-busy="checking">
    <div class="admin-login-brand">
      <span class="admin-brand-mark"><Search :size="20" /></span
      ><strong>pansou</strong><span>管理控制台</span>
    </div>
    <Card class="admin-login-card"
      ><CardHeader
        ><div class="admin-login-shield"><ShieldCheck :size="24" /></div>
        <CardTitle>{{ title }}</CardTitle
        ><CardDescription>{{
          checking
            ? "正在验证账号权限…"
            : authenticated
              ? "当前账号没有管理员权限，请切换管理员账号。"
              : "使用管理员账号访问配置、数据和系统运行状态。"
        }}</CardDescription></CardHeader
      >
      <CardContent
        ><div v-if="checking" class="admin-login-loading" role="status">
          <LoaderCircle class="tw:animate-spin" :size="20" />正在验证
        </div>
        <form
          v-else
          id="admin-login-form"
          class="admin-login-form"
          @submit.prevent="submit"
        >
          <p
            v-if="error || auth.error.value"
            class="admin-login-error"
            role="alert"
          >
            {{ error || auth.error.value }}
          </p>
          <label for="admin-username"
            >用户名<Input
              id="admin-username"
              v-model.trim="username"
              autocomplete="username"
              placeholder="管理员用户名"
              minlength="4"
              maxlength="32"
              required
              :disabled="busy"
          /></label>
          <label for="admin-password"
            >密码<Input
              id="admin-password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              placeholder="输入密码"
              minlength="6"
              maxlength="128"
              required
              :disabled="busy"
          /></label>
          <Button
            type="submit"
            variant="default"
            class="tw:w-full"
            :disabled="busy || !username || password.length < 6"
            ><LoaderCircle v-if="busy" class="tw:animate-spin" :size="16" />{{
              busy ? "正在登录…" : "登录后台"
            }}</Button
          >
        </form></CardContent
      ><CardFooter
        ><Button as-child variant="ghost" class="tw:w-full"
          ><RouterLink to="/"
            ><ArrowLeft :size="15" />返回搜索首页</RouterLink
          ></Button
        ></CardFooter
      >
    </Card>
    <p class="admin-login-caption">
      受保护的管理工作区 · 会话验证与角色权限校验
    </p>
  </section>
</template>
