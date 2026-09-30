import { inject, onBeforeUnmount, provide, ref, type InjectionKey } from "vue";
function createConfirmation() {
  const message = ref("");
  const open = ref(false);
  let resolve: ((result: boolean) => void) | undefined;
  function answer(result: boolean) {
    const current = resolve;
    resolve = undefined;
    open.value = false;
    current?.(result);
  }
  function confirm(messageText: string): Promise<boolean> {
    answer(false);
    message.value = messageText;
    open.value = true;
    return new Promise((done) => {
      resolve = done;
    });
  }
  onBeforeUnmount(() => answer(false));
  return { message, open, answer, confirm };
}
const key: InjectionKey<ReturnType<typeof createConfirmation>> =
  Symbol.for("pansou.admin.confirmation");
export function provideAdminConfirm() {
  const value = createConfirmation();
  provide(key, value);
  return value;
}
export function useAdminConfirm() {
  const value = inject(key);
  if (!value) throw new Error("确认框需要 AdminLayout");
  return value;
}
