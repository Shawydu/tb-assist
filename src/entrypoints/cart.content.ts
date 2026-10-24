export default defineContentScript({
  // TODO(T10): confirm exact hosts
  matches: ['*://cart.taobao.com/*'],
  main() {
    // TODO(T11): cart adapter.
  },
});
