import { Proxima } from '@that-one-tool/proxima-core';
import { createKeyPrefixer, createResponseStripper } from './resp-handling';

const proxima = new Proxima();

proxima.addTransformers(createKeyPrefixer, createResponseStripper).start();
