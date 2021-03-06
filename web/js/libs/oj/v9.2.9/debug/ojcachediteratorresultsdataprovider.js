/**
 * @license
 * Copyright (c) 2014, 2021, Oracle and/or its affiliates.
 * Licensed under The Universal Permissive License (UPL), Version 1.0
 * as shown at https://oss.oracle.com/licenses/upl/
 * @ignore
 */

define(['ojs/ojcore', 'jquery', 'ojs/ojdataprovider', 'ojs/ojcomponentcore', 'ojs/ojeventtarget'], function(oj, $, __DataProvider)
{
  "use strict";

class CachedIteratorResultsDataProvider {
    constructor(dataProvider) {
        this.dataProvider = dataProvider;
        this.CacheAsyncIterable = class {
            constructor(_parent, dataProviderAsyncIterator, cache) {
                this._parent = _parent;
                this.dataProviderAsyncIterator = dataProviderAsyncIterator;
                this.cache = cache;
                this[Symbol.asyncIterator] = () => {
                    return new this._parent.CacheAsyncIterator(this._parent, this.dataProviderAsyncIterator, this.cache);
                };
            }
        };
        this.CacheAsyncIterator = class {
            constructor(_parent, asyncIterator, cache) {
                this._parent = _parent;
                this.asyncIterator = asyncIterator;
                this.cache = cache;
                // offset in our cache
                this._cachedOffset = 0;
                // offset of the underlying DP iterator
                this._iteratedOffset = 0;
            }
            ['next']() {
                let self = this;
                let params = this._parent._lastFetchParams;
                let size = params.size ? params.size : -1;
                // check if we have enough in the cache
                let result;
                if (size == -1) {
                    // we want to fetch everything
                    if (this.cache.isDone()) {
                        result = this.cache.getDataList(params, this._cachedOffset);
                        this._cachedOffset = this._cachedOffset + result.data.length;
                        return Promise.resolve(new this._parent.CacheAsyncIteratorReturnResult(result));
                    }
                }
                else {
                    // we only want to fetch a certain # of rows
                    if (this.cache.getSize() >= this._cachedOffset + size || this.cache.isDone()) {
                        result = this.cache.getDataList(params, this._cachedOffset);
                        this._cachedOffset = this._cachedOffset + result.data.length;
                        if (this._cachedOffset < this.cache.getSize() || !this.cache.isDone()) {
                            // done is false
                            return Promise.resolve(new this._parent.CacheAsyncIteratorYieldResult(result));
                        }
                        return Promise.resolve(new this._parent.CacheAsyncIteratorReturnResult(result));
                    }
                    else if (this._cachedOffset > 0) {
                        // our cache doesn't have all the data we need
                        // so we need to iterate through the DP results until we can
                        // return the relevant segment
                        // check the offset of our iterator to see if we need to do this
                        return new Promise(function (resolve, reject) {
                            if (self._iteratedOffset < self._cachedOffset) {
                                let fetchUntilOffset = function () {
                                    return self.asyncIterator.next().then((result) => {
                                        self._iteratedOffset = self._iteratedOffset + result.value.data.length;
                                        if (self._iteratedOffset >= self._cachedOffset || result.done) {
                                            resolve();
                                        }
                                        else {
                                            return fetchUntilOffset();
                                        }
                                    });
                                };
                                return fetchUntilOffset();
                            }
                            else {
                                resolve();
                            }
                        }).then(() => {
                            return this.asyncIterator.next().then((result) => {
                                self._iteratedOffset = self._iteratedOffset + result.value.data.length;
                                self._cachedOffset = self._iteratedOffset;
                                self.cache.addListResult(result);
                                if (result.done) {
                                    return new self._parent.CacheAsyncIteratorReturnResult(result.value);
                                }
                                else {
                                    return new self._parent.CacheAsyncIteratorYieldResult(result.value);
                                }
                            });
                        });
                    }
                }
                return this.asyncIterator.next().then((result) => {
                    self._iteratedOffset = self._iteratedOffset + result.value.data.length;
                    self._cachedOffset = self._iteratedOffset;
                    self.cache.addListResult(result);
                    if (result.done) {
                        return new self._parent.CacheAsyncIteratorReturnResult(result.value);
                    }
                    else {
                        return new self._parent.CacheAsyncIteratorYieldResult(result.value);
                    }
                });
            }
        };
        this.CacheAsyncIteratorYieldResult = class {
            constructor(value) {
                this.value = value;
                this[CachedIteratorResultsDataProvider._VALUE] = value;
                this[CachedIteratorResultsDataProvider._DONE] = false;
            }
        };
        this.CacheAsyncIteratorReturnResult = class {
            constructor(value) {
                this.value = value;
                this[CachedIteratorResultsDataProvider._VALUE] = value;
                this[CachedIteratorResultsDataProvider._DONE] = true;
            }
        };
        let self = this;
        this.cache = new __DataProvider.DataCache();
        this._lastFetchParams = null;
        // Add createOptimizedKeyMap method to this DataProvider if the wrapped DataProvider supports it
        if (dataProvider.createOptimizedKeyMap) {
            this.createOptimizedKeyMap = (initialMap) => {
                return dataProvider.createOptimizedKeyMap(initialMap);
            };
        }
        // Add createOptimizedKeySet method to this DataProvider if the wrapped DataProvider supports it
        if (dataProvider.createOptimizedKeySet) {
            this.createOptimizedKeySet = (initialSet) => {
                return dataProvider.createOptimizedKeySet(initialSet);
            };
        }
        // Listen to mutate event on wrapped DataProvider
        dataProvider.addEventListener(CachedIteratorResultsDataProvider._MUTATE, (event) => {
            // First allow the cache to process the mutations, which may result in different detail
            self.cache.processMutations(event.detail);
            // Then fire mutate with new detail
            self.dispatchEvent(event);
        });
        // Listen to refresh event on wrapped DataProvider
        dataProvider.addEventListener(CachedIteratorResultsDataProvider._REFRESH, (event) => {
            // Invalidate the cache on refresh event
            self.cache.reset();
            self.dispatchEvent(event);
        });
    }
    containsKeys(params) {
        let finalResults = new Set();
        let neededKeys = new Set();
        // First resolve any keys that can be found in the cache
        let cacheResults = this.cache.getDataByKeys(params);
        params.keys.forEach((key) => {
            let item = cacheResults.results.get(key);
            if (item) {
                finalResults.add(key);
            }
            else {
                neededKeys.add(key);
            }
        });
        if (neededKeys.size == 0) {
            // Return the result if all keys have been resolved from cache
            return Promise.resolve({ containsParameters: params, results: finalResults });
        }
        else {
            // If there are unresolved keys, delegate to the wrapped DataProvider
            let newParams = { attributes: params.attributes, keys: neededKeys, scope: params.scope };
            return this.dataProvider.containsKeys(newParams).then((containsKeysResults) => {
                containsKeysResults.results.forEach((key) => {
                    finalResults.add(key);
                });
                return { containsParameters: params, results: finalResults };
            });
        }
    }
    fetchByKeys(params) {
        let finalResults = new Map();
        let neededKeys = new Set();
        // First resolve any keys that can be found in the cache
        let cacheResults = this.cache.getDataByKeys(params);
        params.keys.forEach((key) => {
            let item = cacheResults.results.get(key);
            if (item) {
                finalResults.set(key, item);
            }
            else {
                neededKeys.add(key);
            }
        });
        if (neededKeys.size == 0) {
            // Return the result if all keys have been resolved from cache
            return Promise.resolve({ fetchParameters: params, results: finalResults });
        }
        else {
            // If there are unresolved keys, delegate to the wrapped DataProvider
            let newParams = { attributes: params.attributes, keys: neededKeys, scope: params.scope };
            return this.dataProvider.fetchByKeys(newParams).then((fetchByKeysResults) => {
                fetchByKeysResults.results.forEach((item, key) => {
                    finalResults.set(key, item);
                });
                return { fetchParameters: params, results: finalResults };
            });
        }
    }
    fetchByOffset(params) {
        // size is optional so use the default size if not specified
        let size = params.size ? params.size : CachedIteratorResultsDataProvider._DEFAULT_SIZE;
        // Use the cache if the attributes, filterCriterion, and sortCriteria match and the offset is in range
        // We also need to check if the cached rows can satisfy the requested size.
        if (this._compareLastFetchParameters(params) && params.offset + size < this.cache.getSize()) {
            let updatedParams = JSON.parse(JSON.stringify(params));
            updatedParams.size = size;
            let results = this.cache.getDataByOffset(updatedParams);
            if (results) {
                return Promise.resolve(results);
            }
        }
        return this.dataProvider.fetchByOffset(params);
    }
    fetchFirst(params) {
        // Invalidate the cache if fetchFirst is called with different fetch parameters from last call
        if (!this._compareLastFetchParameters(params)) {
            this.cache.reset();
            // Remember the last fetch parameters
        }
        this._storeLastFetchParams(params);
        const asyncIterable = this.dataProvider.fetchFirst(params);
        return new this.CacheAsyncIterable(this, asyncIterable[Symbol.asyncIterator](), this.cache);
    }
    getCapability(capabilityName) {
        let capability = this.dataProvider.getCapability(capabilityName);
        if (capabilityName === 'fetchCapability') {
            return { attributeFilter: capability.attributeFilter, caching: 'visitedByCurrentIterator' };
        }
        return capability;
    }
    getTotalSize() {
        // If there is no filterCriterion and the cache is complete, we can just return the cache size
        if (!this._lastFetchParams.filterCriterion && this.cache.isDone()) {
            return Promise.resolve(this.cache.getSize());
        }
        // Otherwise delegate to the wrapped DataProvider
        return this.dataProvider.getTotalSize();
    }
    isEmpty() {
        // If there is no filterCriterion and the cache is complete, we can just return this info based on the cache
        if (!this._lastFetchParams.filterCriterion && this.cache.isDone()) {
            return this.cache.getSize() === 0 ? 'yes' : 'no';
        }
        // Otherwise delegate to the wrapped DataProvider
        return this.dataProvider.isEmpty();
    }
    _compareLastFetchParameters(params) {
        params = params || {};
        return (this._lastFetchParams != null &&
            oj.Object.compareValues(this._lastFetchParams.attributes, params.attributes || null) &&
            oj.Object.compareValues(this._lastFetchParams.filterDef, this._getFilterDef(params.filterCriterion)) &&
            oj.Object.compareValues(this._lastFetchParams.sortCriteria, params.sortCriteria || null));
    }
    _storeLastFetchParams(params) {
        params = params || {};
        this._lastFetchParams = {};
        this._lastFetchParams.size = params.size;
        this._lastFetchParams.attributes = params.attributes
            ? JSON.parse(JSON.stringify(params.attributes))
            : null;
        this._lastFetchParams.filterDef = this._getFilterDef(params.filterCriterion);
        this._lastFetchParams.sortCriteria = params.sortCriteria
            ? JSON.parse(JSON.stringify(params.sortCriteria))
            : null;
    }
    _getFilterDef(filter) {
        if (!filter) {
            return null;
        }
        let filterDef = {};
        Object.keys(filter).forEach(function (property) {
            if (property != 'filter') {
                filterDef[property] = filter[property];
            }
        });
        return filterDef;
    }
}
CachedIteratorResultsDataProvider._KEY = 'key';
CachedIteratorResultsDataProvider._KEYS = 'keys';
CachedIteratorResultsDataProvider._DATA = 'data';
CachedIteratorResultsDataProvider._STARTINDEX = 'startIndex';
CachedIteratorResultsDataProvider._SORT = 'sort';
CachedIteratorResultsDataProvider._SORTCRITERIA = 'sortCriteria';
CachedIteratorResultsDataProvider._FILTERCRITERION = 'filterCriterion';
CachedIteratorResultsDataProvider._METADATA = 'metadata';
CachedIteratorResultsDataProvider._ITEMS = 'items';
CachedIteratorResultsDataProvider._FROM = 'from';
CachedIteratorResultsDataProvider._OFFSET = 'offset';
CachedIteratorResultsDataProvider._REFRESH = 'refresh';
CachedIteratorResultsDataProvider._MUTATE = 'mutate';
CachedIteratorResultsDataProvider._SIZE = 'size';
CachedIteratorResultsDataProvider._FETCHPARAMETERS = 'fetchParameters';
CachedIteratorResultsDataProvider._VALUE = 'value';
CachedIteratorResultsDataProvider._DONE = 'done';
CachedIteratorResultsDataProvider._RESULTS = 'results';
CachedIteratorResultsDataProvider._CONTAINSPARAMETERS = 'containsParameters';
CachedIteratorResultsDataProvider._DEFAULT_SIZE = 25;
CachedIteratorResultsDataProvider._CONTAINSKEYS = 'containsKeys';
CachedIteratorResultsDataProvider._FETCHBYKEYS = 'fetchByKeys';
CachedIteratorResultsDataProvider._FETCHBYOFFSET = 'fetchByOffset';
CachedIteratorResultsDataProvider._FETCHFIRST = 'fetchFirst';
CachedIteratorResultsDataProvider._ADDEVENTLISTENER = 'addEventListener';
CachedIteratorResultsDataProvider._FETCHATTRIBUTES = 'attributes';
oj['CachedIteratorResultsDataProvider'] = CachedIteratorResultsDataProvider;
oj.CachedIteratorResultsDataProvider = CachedIteratorResultsDataProvider;
oj.EventTargetMixin.applyMixin(CachedIteratorResultsDataProvider);


/**
 * @preserve Copyright 2013 jQuery Foundation and other contributors
 * Released under the MIT license.
 * http://jquery.org/license
 */

/* jslint browser: true,devel:true*/
/**
 *
 * @since 9.1.0
 * @export
 * @final
 * @class CachedIteratorResultsDataProvider
 * @implements DataProvider
 * @classdesc This is an internal wrapper class meant to be used by JET collection components to provide highwatermark scrolling optimizations.
 * This wrapper will cache the most results of the most recently invoked fetchFirst by attributes, filterCriterion, and sortCriteria.
 * @param {DataProvider} dataProvider the DataProvider.
 * @ojsignature [{target: "Type",
 *               value: "class CachedIteratorResultsDataProvider<K, D> implements DataProvider<K, D>",
 *               genericParameters: [{"name": "K", "description": "Type of Key"}, {"name": "D", "description": "Type of Data"}]},
 *               {target: "Type",
 *               value: "DataProvider<K, D>",
 *               for: "dataProvider"}]
 * @ojtsimport {module: "ojdataprovider", type: "AMD", imported: ["DataProvider", "SortCriterion", "FetchByKeysParameters",
 * "ContainsKeysResults","FetchByKeysResults","FetchByOffsetParameters","FetchByOffsetResults",
 * "FetchListResult","FetchListParameters"]}
 * @ojtsmodule
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name containsKeys
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name createOptimizedKeySet
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name createOptimizedKeyMap
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name fetchFirst
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name fetchByKeys
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name fetchByOffset
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name getCapability
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name getTotalSize
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name isEmpty
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name addEventListener
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name removeEventListener
 */

/**
 * @inheritdoc
 * @memberof CachedIteratorResultsDataProvider
 * @instance
 * @method
 * @name dispatchEvent
 */

/**
 * End of jsdoc
 */

  return CachedIteratorResultsDataProvider
});