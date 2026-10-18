/** Library entry: use the pieces programmatically (see README "Library use"). */
const { KilidAdapter } = require('./kilid/adapter');
const { CrawlRunner } = require('./runner');
const { StateStore } = require('./state');
const { toContractListing } = require('./listing');
const { createSinks, SqliteSink, JsonlSink, HttpSink } = require('./sinks');
const { HttpClient, HttpError } = require('./http-client');
const { loadConfig } = require('./config');

module.exports = {
  KilidAdapter, CrawlRunner, StateStore, toContractListing,
  createSinks, SqliteSink, JsonlSink, HttpSink, HttpClient, HttpError, loadConfig
};
