/**
 * Secure Sandboxed Preload Script for Print Rendering Worker
 * 
 * Enforces strict context isolation and exposes only minimal required communication channels.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printWorkerAPI', {
    /**
     * Listens for rendering instructions from main process
     * @param {Function} callback - (taskData) => void
     */
    onRenderTask: (callback) => {
        if (typeof callback !== 'function') return;
        ipcRenderer.on('render-task', (_event, data) => {
            callback(data);
        });
    },

    /**
     * Signals main process that document rendering is fully complete
     */
    notifyRenderComplete: () => {
        ipcRenderer.send('print-render-complete');
    },

    /**
     * Signals main process that document rendering failed
     * @param {string} errorMessage 
     */
    notifyRenderFailed: (errorMessage) => {
        ipcRenderer.send('print-render-failed', String(errorMessage || 'Unknown rendering error'));
    }
});
