'use strict';

const BbPromise = require('bluebird');
const _ = require('lodash');
const path = require('path');
const chai = require('chai');
const sinon = require('sinon');
const mockery = require('mockery');
const Serverless = require('serverless');

// Mocks
const childProcessMockFactory = require('./mocks/child_process.mock');
const fsExtraMockFactory = require('./mocks/fs-extra.mock');
const packageMock = require('./mocks/package.mock.json');

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));

const expect = chai.expect;

describe('packExternalModules', () => {
  let sandbox;
  let baseModule;
  let serverless;
  let module;

  // Mocks
  let npmMock;
  let childProcessMock;
  let fsExtraMock;
  // Serverless stubs
  let writeFileSyncStub;

  before(() => {
    sandbox = sinon.sandbox.create();
    sandbox.usingPromise(BbPromise);

    childProcessMock = childProcessMockFactory.create(sandbox);
    fsExtraMock = fsExtraMockFactory.create(sandbox);

    mockery.enable({ warnOnUnregistered: false });
    mockery.registerMock('npm-programmatic', npmMock);
    mockery.registerMock('child_process', childProcessMock);
    mockery.registerMock('fs-extra', fsExtraMock);
    mockery.registerMock(path.join(process.cwd(), 'package.json'), packageMock);
    baseModule = require('../lib/packExternalModules');
    Object.freeze(baseModule);
  });

  after(() => {
    mockery.disable();
    mockery.deregisterAll();
  });

  beforeEach(() => {
    serverless = new Serverless();
    serverless.cli = {
      log: sandbox.stub(),
      consoleLog: sandbox.stub()
    };

    writeFileSyncStub = sandbox.stub(serverless.utils, 'writeFileSync');
    _.set(serverless, 'service.custom.webpackIncludeModules', true);

    module = _.assign({
      serverless,
      options: {},
    }, baseModule);
  });

  afterEach(() => {
    // Reset all counters and restore all stubbed functions
    writeFileSyncStub.reset();
    childProcessMock.exec.reset();
    fsExtraMock.copy.reset();
    sandbox.reset();
    sandbox.restore();
  });

  describe('packExternalModules()', () => {
    // Test data
    const stats = {
      stats: [
        {
          compilation: {
            chunks: [
              {
                modules: [
                  {
                    identifier: _.constant('"crypto"')
                  },
                  {
                    identifier: _.constant('"uuid/v4"')
                  },
                  {
                    identifier: _.constant('external "eslint"')
                  },
                  {
                    identifier: _.constant('"mockery"')
                  },
                  {
                    identifier: _.constant('"@scoped/vendor/module1"')
                  },
                  {
                    identifier: _.constant('external "@scoped/vendor/module2"')
                  },
                  {
                    identifier: _.constant('external "uuid/v4"')
                  },
                  {
                    identifier: _.constant('external "bluebird"')
                  },
                ]
              }
            ],
            compiler: {
              outputPath: '/my/Service/Path/.webpack/service'
            }
          }
        }
      ]
    };
    const noExtStats = {
      stats: [
        {
          compilation: {
            chunks: [
              {
                modules: [
                  {
                    identifier: _.constant('"crypto"')
                  },
                  {
                    identifier: _.constant('"uuid/v4"')
                  },
                  {
                    identifier: _.constant('"mockery"')
                  },
                  {
                    identifier: _.constant('"@scoped/vendor/module1"')
                  },
                ]
              }
            ],
            compiler: {
              outputPath: '/my/Service/Path/.webpack/service'
            }
          }
        }
      ]
    };

    it('should do nothing if webpackIncludeModules is not set', () => {
      _.unset(serverless, 'service.custom.webpackIncludeModules');
      return expect(module.packExternalModules({ stats: [] })).to.eventually.deep.equal({ stats: [] })
      .then(() => BbPromise.all([
        expect(fsExtraMock.copy).to.not.have.been.called,
        expect(childProcessMock.exec).to.not.have.been.called,
        expect(writeFileSyncStub).to.not.have.been.called,
      ]));
    });
    it('should copy external modules and its dependencies to node_modules', () => {
      const expectedPackageJSON = {
        dependencies: {
          '@scoped/vendor': '1.0.0',
          uuid: '^5.4.1',
          bluebird: '^3.4.0',
        }
      };
      const graphDependency = {
        name: 'module',
        dependencies: {
          '@scoped/vendor': {
            version: '1.0.0',
          },
          'bluebird': {
            version: '1.0.0',
          },
          'uuid': {
            version: '2.3.4',
            dependencies: {
              'dependency1': {
                version: '5.4.3',
                dependencies: {
                  '@dependency2/scoped': {
                    version: '2.1.4',
                  },
                },
              },
            }
          },
        }
      };
      // here the order is important. First the more deep dependencies.
      const expectedModulesList = [
        '@dependency2/scoped',
        'dependency1',
        '@scoped/vendor',
        'bluebird',
        'uuid',
      ];
      module.webpackOutputPath = 'outputPath';
      fsExtraMock.copy.yields();
      childProcessMock.exec.onFirstCall().yields(null, JSON.stringify(graphDependency), '');
      childProcessMock.exec.onSecondCall().yields();
      return expect(module.packExternalModules(stats)).to.be.fulfilled
      .then(() => BbPromise.all([
        // npm install should have been called with all externals from the package mock
        ..._.map(expectedModulesList, (moduleName) =>
          expect(fsExtraMock.copy).to.have.been.calledWith(
            path.join(process.cwd(), 'node_modules', moduleName),
            path.join(module.webpackOutputPath, 'dependencies', 'node_modules', moduleName)
          )),
        // The module package JSON and the composite one should have been stored
        expect(writeFileSyncStub).to.have.been.calledTwice,
        expect(writeFileSyncStub.firstCall.args[1]).to.equal('{}'),
        expect(writeFileSyncStub.secondCall.args[1]).to.equal(JSON.stringify(expectedPackageJSON, null, 2)),
        // npm ls and npm prune should have been called
        expect(childProcessMock.exec).to.have.been.calledTwice,
        expect(childProcessMock.exec.firstCall).to.have.been.calledWith(
          'npm ls -prod -json -depth=1'
        ),
        expect(childProcessMock.exec.secondCall).to.have.been.calledWith(
          'npm prune'
        )
      ]));
    });
    // @TODO should reject if fs fails
    it('should reject if npm install fails', () => {
      module.webpackOutputPath = 'outputPath';
      npmMock.install.returns(BbPromise.reject(new Error('npm install failed')));
      fsExtraMock.copy.yields();
      childProcessMock.exec.onFirstCall().yields(null, '{}', '');
      childProcessMock.exec.onSecondCall().yields();
      return expect(module.packExternalModules(stats)).to.be.rejectedWith('npm install failed')
      .then(() => BbPromise.all([
        // npm install should have been called with all externals from the package mock
        expect(npmMock.install).to.have.been.calledOnce,
        // npm ls and npm prune should have been called
        expect(childProcessMock.exec).to.have.been.calledOnce,
      ]));
    });

    it('should reject if npm returns a critical error', () => {
      const stderr = 'ENOENT: No such file';
      module.webpackOutputPath = 'outputPath';
      npmMock.install.returns(BbPromise.resolve());
      fsExtraMock.copy.yields();
      childProcessMock.exec.yields(new Error('something went wrong'), '{}', stderr);
      return expect(module.packExternalModules(stats)).to.be.rejectedWith('something went wrong')
      .then(() => BbPromise.all([
        expect(npmMock.install).to.not.have.been.called,
        // The module package JSON and the composite one should have been stored
        expect(writeFileSyncStub).to.not.have.been.called,
        // The modules should have been copied
        expect(fsExtraMock.copy).to.not.have.been.called,
        // npm ls and npm prune should have been called
        expect(childProcessMock.exec).to.have.been.calledOnce,
        expect(childProcessMock.exec.firstCall).to.have.been.calledWith(
          'npm ls -prod -json -depth=1'
        ),
      ]));
    });

    it('should ignore minor local NPM errors and log them', () => {
      const expectedPackageJSON = {
        dependencies: {
          '@scoped/vendor': '1.0.0',
          uuid: '^5.4.1',
          bluebird: '^3.4.0'
        }
      };
      const stderr = _.join(
        [
          'npm ERR! extraneous: sinon@2.3.8 ./babel-dynamically-entries/node_modules/serverless-webpack/node_modules/sinon',
          'npm ERR! missing: internalpackage-1@1.0.0, required by internalpackage-2@1.0.0',
          'npm ERR! peer dep missing: sinon@2.3.8',
        ],
        '\n'
      );
      const lsResult = {
        version: '1.0.0',
        problems: [
          'npm ERR! extraneous: sinon@2.3.8 ./babel-dynamically-entries/node_modules/serverless-webpack/node_modules/sinon',
          'npm ERR! missing: internalpackage-1@1.0.0, required by internalpackage-2@1.0.0',
          'npm ERR! peer dep missing: sinon@2.3.8',
        ],
        dependencies: {
          '@scoped/vendor': '1.0.0',
          uuid: '^5.4.1',
          bluebird: '^3.4.0'
        }
      };

      module.webpackOutputPath = 'outputPath';
      npmMock.install.returns(BbPromise.resolve());
      fsExtraMock.copy.yields();
      childProcessMock.exec.onFirstCall().yields(new Error('NPM error'), JSON.stringify(lsResult), stderr);
      childProcessMock.exec.onSecondCall().yields();
      return expect(module.packExternalModules(stats)).to.be.fulfilled
      .then(() => BbPromise.all([
        // npm install should have been called with all externals from the package mock
        expect(npmMock.install).to.have.been.calledOnce,
        expect(npmMock.install).to.have.been.calledWithExactly([
          '@scoped/vendor@1.0.0',
          'uuid@^5.4.1',
          'bluebird@^3.4.0'
        ],
        {
          cwd: path.join('outputPath', 'dependencies'),
          maxBuffer: 204800,
          save: true
        }),
        // The module package JSON and the composite one should have been stored
        expect(writeFileSyncStub).to.have.been.calledTwice,
        expect(writeFileSyncStub.firstCall.args[1]).to.equal('{}'),
        expect(writeFileSyncStub.secondCall.args[1]).to.equal(JSON.stringify(expectedPackageJSON, null, 2)),
        // The modules should have been copied
        expect(fsExtraMock.copy).to.have.been.calledOnce,
        // npm ls and npm prune should have been called
        expect(childProcessMock.exec).to.have.been.calledTwice,
        expect(childProcessMock.exec.firstCall).to.have.been.calledWith(
          'npm ls -prod -json -depth=1'
        ),
        expect(childProcessMock.exec.secondCall).to.have.been.calledWith(
          'npm prune'
        )
      ]));
    });

    it('should not install modules if no external modules are reported', () => {
      module.webpackOutputPath = 'outputPath';
      fsExtraMock.copy.yields();
      childProcessMock.exec.yields(null, '{}', '');
      return expect(module.packExternalModules(noExtStats)).to.be.fulfilled
      .then(stats => BbPromise.all([
        expect(stats).to.deep.equal(noExtStats),
        // The module package JSON and the composite one should have been stored
        expect(writeFileSyncStub).to.not.have.been.called,
        // The modules should have been copied
        expect(fsExtraMock.copy).to.not.have.been.called,
        // npm ls and npm prune should have been called
        expect(childProcessMock.exec).to.have.been.calledOnce,
      ]));
    });
  });
});
