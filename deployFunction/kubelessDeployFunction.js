/*
 Copyright 2017 Bitnami.

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

'use strict';

const _ = require('lodash');
const BbPromise = require('bluebird');
const Api = require('kubernetes-client');
const fs = require('fs');
const helpers = require('../lib/helpers');
const JSZip = require('jszip');
const path = require('path');

class KubelessDeploy {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('google');

    this.hooks = {
      'deploy:function:deploy': () => BbPromise.bind(this)
        .then(this.validate)
        .then(this.deployFunction),
    };
    // Store the result of loading the Zip file
    this.loadZip = _.memoize(JSZip.loadAsync);
  }

  validate() {
    const unsupportedOptions = ['stage', 'region'];
    helpers.warnUnsupportedOptions(
      unsupportedOptions,
      this.options,
      this.serverless.cli.log.bind(this.serverless.cli)
    );
    return BbPromise.resolve();
  }

  getFunctionContent(relativePath) {
    const pkg = this.options.package ||
      this.serverless.service.package.path;
    let resultPromise = null;
    if (pkg) {
      resultPromise = this.loadZip(fs.readFileSync(pkg)).then(
        (zip) => zip.file(relativePath).async('string')
      );
    } else {
      resultPromise = new BbPromise((resolve, reject) => {
        fs.readFile(
          path.join(this.serverless.config.servicePath || '.', relativePath),
          (err, d) => {
            if (err) {
              reject(err);
            } else {
              resolve(d.toString());
            }
          });
      });
    }
    return resultPromise;
  }

  getThirdPartyResources() {
    return new Api.ThirdPartyResources(
      helpers.getConnectionOptions(helpers.loadKubeConfig())
    );
  }

  deployFunction() {
    const thirdPartyResources = this.getThirdPartyResources();
    const core = new Api.Core(helpers.getConnectionOptions(helpers.loadKubeConfig()));
    thirdPartyResources.addResource('functions');
    let files = {
      handler: null,
      deps: null,
    };
    const errors = [];
    let counter = 0;
    return new BbPromise((resolve, reject) => {
      const func = this.serverless.service.functions[this.options.function];
      if (this.serverless.service.provider.runtime.match(/python/)) {
        files = {
          handler: `${func.handler.toString().split('.')[0]}.py`,
          deps: 'requirements.txt',
        };
      } else {
        reject(
            `The runtime ${this.serverless.service.provider.runtime} is not supported yet`
          );
      }

      this.getFunctionContent(files.handler)
      .then(functionContent => {
        this.getFunctionContent(files.deps)
        .catch(() => {
          // No requirements found
        })
        .then((requirementsContent) => {
          const funcs = {
            apiVersion: 'k8s.io/v1',
            kind: 'Function',
            metadata: {
              name: this.options.function,
              namespace: thirdPartyResources.namespaces.namespace,
            },
            spec: {
              deps: requirementsContent || '',
              function: functionContent,
              handler: func.handler,
              runtime: this.serverless.service.provider.runtime,
              topic: '',
              type: 'HTTP',
            },
          };
          console.log(functionContent);
          // Create function
          thirdPartyResources.ns.functions(this.options.function).put({ body: funcs }, (err) => {
            if (err) {
              if (err.code === 409) {
                this.serverless.cli.log(
                  `The function ${this.options.function} is already deployed. ` +
                  'Remove it if you want to deploy it again.'
                );
              } else {
                errors.push(
                  `Unable to deploy the function ${this.options.function}. Received:\n` +
                  `  Code: ${err.code}\n` +
                  `  Message: ${err.message}`
                );
              }
            } else {
              core.pods.get((err1, podsInfo) => {
                if (err1) reject(err1);
                const functionPod = _.find(
                  podsInfo.items,
                  (pod) => pod.metadata.labels.function === this.options.function
                );
                console.log(functionPod.metadata.name);
                // core.ns.pods(functionPod.metadata.name).delete((err2) => {
                //   if (err2) throw err2;
                this.serverless.cli.log(
                    `Function ${this.options.function} succesfully redeployed`
                  );
                // });
              });
            }
            counter++;
            if (counter === _.keys(this.serverless.service.functions).length) {
              if (_.isEmpty(errors)) {
                resolve();
              } else {
                reject(
                  `Found errors while deploying the given functions:\n${errors.join('\n')}`
                );
              }
            }
          });
        });
      });
    });
  }
}

module.exports = KubelessDeploy;