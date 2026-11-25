/** @param {string} url */
export async function openNativeWebSocket(url) {
  const socket = new WebSocket(url, 'mqtt');
  socket.binaryType = 'arraybuffer';
  const listeners = new AbortController();
  let timer;
  try {
    await new Promise((resolve, reject) => {
      const fail = () => {
        reject(new Error('MQTT WebSocket handshake failed'));
      };
      const options = { once: true, signal: listeners.signal };
      socket.addEventListener('open', resolve, options);
      socket.addEventListener('error', fail, options);
      socket.addEventListener('close', fail, options);
      timer = setTimeout(fail, 3000);
    });
    if (socket.protocol !== 'mqtt') throw new Error('Native WebSocket did not negotiate mqtt');
    return socket;
  } catch (error) {
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    throw error;
  } finally {
    clearTimeout(timer);
    listeners.abort();
  }
}
