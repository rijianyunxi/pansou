import { ref } from 'vue';

type ToastType = 'info' | 'success' | 'error';
interface ToastOptions {
  duration?: number;
  loading?: boolean;
}
export type ShowToast = (message: string, type?: ToastType, options?: ToastOptions) => () => void;

export function useToast() {
  const toast = ref({ show: false, message: '', type: 'info' as ToastType, loading: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentId = 0;

  function hideToast() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    toast.value.show = false;
    currentId++;
  }

  const showToast: ShowToast = (message, type = 'info', options = {}) => {
    if (!message.trim()) return () => {};
    hideToast();
    const id = currentId;
    toast.value = { show: true, message, type, loading: !!options.loading };
    const dismiss = () => { if (id === currentId) hideToast(); };
    const duration = options.duration ?? (type === 'error' ? 6000 : 3500);
    if (duration > 0) timer = setTimeout(dismiss, duration);
    return dismiss;
  };

  return { toast, showToast, hideToast };
}
