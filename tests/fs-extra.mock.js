'use strict';

const sinon = require('sinon');

module.exports = () => ({
  _resetSpies() {
    for (const p in this) {
      if (this.hasOwnProperty(p) && p !== '_resetSpies') {
        this[p].reset();
      }
    }
  },
  removeSync: sinon.spy(),
});
