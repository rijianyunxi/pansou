import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "../app.vue";
import HomePage from "../pages/index/index.vue";
import CopyrightPage from "../pages/copyright.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: HomePage },
    { path: "/copyright", component: CopyrightPage },
    {
      path: "/admin",
      component: () => import("../components/admin/AdminLayout.vue"),
      children: [
        { path: "", redirect: "/admin/sources" },
        {
          path: "sources",
          component: () => import("../pages/admin/[...view].vue"),
        },
        {
          path: "monitor",
          component: () => import("../pages/admin/monitor.vue"),
        },
        { path: "crawl", component: () => import("../pages/admin/crawl.vue") },
        {
          path: "proxies",
          component: () => import("../pages/admin/proxies.vue"),
        },
        {
          path: "resources",
          component: () => import("../pages/admin/resources.vue"),
        },
        {
          path: "hot-searches",
          component: () => import("../pages/admin/hot-searches.vue"),
        },
        { path: "users", component: () => import("../pages/admin/users.vue") },
        { path: "logs", component: () => import("../pages/admin/logs.vue") },
        { path: "link-cleanup", redirect: to => ({ path: "/admin/tasks", query: { ...to.query, kind: "cleanup" } }) },
        { path: "tasks", component: () => import("../pages/admin/tasks.vue") },
        { path: "cloud-accounts", component: () => import("../pages/admin/cloud-accounts.vue") },
        {
          path: "policies",
          component: () => import("../pages/admin/policies.vue"),
        },
        { path: ":pathMatch(.*)*", redirect: "/admin/sources" },
      ],
    },
  ],
});
const app = createApp(App);
app.use(router);
app.mount("#app");
