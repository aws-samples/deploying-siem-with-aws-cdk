#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import { SiemOnEsStack } from '../lib/siem-on-es-stack';

const app = new cdk.App();
const RESOURCE_SUFFIX:string = app.node.tryGetContext('resource_suffix');
new SiemOnEsStack(app, 'aes-siem'+RESOURCE_SUFFIX);
