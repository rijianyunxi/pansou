function owner() { const pages = getCurrentPages(); return pages[pages.length - 1]; }
function showToast(options, page = owner()) {
  if (!page || page._feedbackGone) return;
  clearTimeout(page._feedbackTimer);
  page.setData({ feedbackToast: { text: options.title || '操作未完成', kind: options.icon || 'none' } });
  page._feedbackTimer = setTimeout(() => {
    if (!page._feedbackGone) page.setData({ feedbackToast: null });
  }, options.duration || 2600);
}
function showModal(options, page = owner()) {
  if (!page || page._feedbackGone || page._feedbackModal) return;
  page._feedbackModal = options;
  page.setData({ feedbackModal: { title: options.title || '提示', content: options.content || '', confirmText: options.confirmText || '确定', cancelText: options.cancelText || '取消', showCancel: options.showCancel !== false } });
}
function closeModal(page, confirm) {
  const options = page._feedbackModal;
  page._feedbackModal = null;
  page.setData({ feedbackModal: null });
  if (options && options.success) options.success({ confirm, cancel: !confirm });
}
function dispose(page) {
  clearTimeout(page._feedbackTimer);
  page._feedbackGone = true;
  page._feedbackModal = null;
}
module.exports = { owner, showToast, showModal, closeModal, dispose };
