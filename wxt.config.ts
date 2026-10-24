import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  srcDir: 'src',
  vite: () => ({ plugins: [preact()] }),
  manifest: {
    name: 'tb-assist',
    description: 'Taobao consolidation checkout cost optimizer',
    // NFR-2: exactly these permissions.
    permissions: ['storage', 'sidePanel', 'tabs', 'scripting'],
    // TODO(T10): confirm exact hosts
    host_permissions: ['*://cart.taobao.com/*', '*://buy.taobao.com/*'],
  },
});
