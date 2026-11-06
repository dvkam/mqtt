import mqtt from 'mqtt';

export const openBrowserClient = (url) => mqtt.connect(url, { protocolVersion: 5 });
