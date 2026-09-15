"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/react/cjs/react.production.js
var require_react_production = __commonJS({
  "node_modules/react/cjs/react.production.js"(exports2) {
    "use strict";
    var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element");
    var REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal");
    var REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment");
    var REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode");
    var REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler");
    var REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer");
    var REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context");
    var REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref");
    var REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense");
    var REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo");
    var REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy");
    var REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity");
    var REACT_VIEW_TRANSITION_TYPE = /* @__PURE__ */ Symbol.for("react.view_transition");
    var MAYBE_ITERATOR_SYMBOL = Symbol.iterator;
    function getIteratorFn(maybeIterable) {
      if (null === maybeIterable || "object" !== typeof maybeIterable) return null;
      maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
      return "function" === typeof maybeIterable ? maybeIterable : null;
    }
    var ReactNoopUpdateQueue = {
      isMounted: function() {
        return false;
      },
      enqueueForceUpdate: function() {
      },
      enqueueReplaceState: function() {
      },
      enqueueSetState: function() {
      }
    };
    var assign = Object.assign;
    var emptyObject = {};
    function Component(props, context, updater) {
      this.props = props;
      this.context = context;
      this.refs = emptyObject;
      this.updater = updater || ReactNoopUpdateQueue;
    }
    Component.prototype.isReactComponent = {};
    Component.prototype.setState = function(partialState, callback) {
      if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
        throw Error(
          "takes an object of state variables to update or a function which returns an object of state variables."
        );
      this.updater.enqueueSetState(this, partialState, callback, "setState");
    };
    Component.prototype.forceUpdate = function(callback) {
      this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
    };
    function ComponentDummy() {
    }
    ComponentDummy.prototype = Component.prototype;
    function PureComponent(props, context, updater) {
      this.props = props;
      this.context = context;
      this.refs = emptyObject;
      this.updater = updater || ReactNoopUpdateQueue;
    }
    var pureComponentPrototype = PureComponent.prototype = new ComponentDummy();
    pureComponentPrototype.constructor = PureComponent;
    assign(pureComponentPrototype, Component.prototype);
    pureComponentPrototype.isPureReactComponent = true;
    var isArrayImpl = Array.isArray;
    function noop() {
    }
    var ReactSharedInternals = { H: null, A: null, T: null, S: null };
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function ReactElement(type, key, props) {
      var refProp = props.ref;
      return {
        $$typeof: REACT_ELEMENT_TYPE,
        type,
        key,
        ref: void 0 !== refProp ? refProp : null,
        props
      };
    }
    function cloneAndReplaceKey(oldElement, newKey) {
      return ReactElement(oldElement.type, newKey, oldElement.props);
    }
    function isValidElement(object) {
      return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
    }
    function escape(key) {
      var escaperLookup = { "=": "=0", ":": "=2" };
      return "$" + key.replace(/[=:]/g, function(match) {
        return escaperLookup[match];
      });
    }
    var userProvidedKeyEscapeRegex = /\/+/g;
    function getElementKey(element, index) {
      return "object" === typeof element && null !== element && null != element.key ? escape("" + element.key) : index.toString(36);
    }
    function resolveThenable(thenable) {
      switch (thenable.status) {
        case "fulfilled":
          return thenable.value;
        case "rejected":
          throw thenable.reason;
        default:
          switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
            function(fulfilledValue) {
              "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
            },
            function(error) {
              "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
            }
          )), thenable.status) {
            case "fulfilled":
              return thenable.value;
            case "rejected":
              throw thenable.reason;
          }
      }
      throw thenable;
    }
    function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
      var type = typeof children;
      if ("undefined" === type || "boolean" === type) children = null;
      var invokeCallback = false;
      if (null === children) invokeCallback = true;
      else
        switch (type) {
          case "bigint":
          case "string":
          case "number":
            invokeCallback = true;
            break;
          case "object":
            switch (children.$$typeof) {
              case REACT_ELEMENT_TYPE:
              case REACT_PORTAL_TYPE:
                invokeCallback = true;
                break;
              case REACT_LAZY_TYPE:
                return invokeCallback = children._init, mapIntoArray(
                  invokeCallback(children._payload),
                  array,
                  escapedPrefix,
                  nameSoFar,
                  callback
                );
            }
        }
      if (invokeCallback)
        return callback = callback(children), invokeCallback = "" === nameSoFar ? "." + getElementKey(children, 0) : nameSoFar, isArrayImpl(callback) ? (escapedPrefix = "", null != invokeCallback && (escapedPrefix = invokeCallback.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
          return c;
        })) : null != callback && (isValidElement(callback) && (callback = cloneAndReplaceKey(
          callback,
          escapedPrefix + (null == callback.key || children && children.key === callback.key ? "" : ("" + callback.key).replace(
            userProvidedKeyEscapeRegex,
            "$&/"
          ) + "/") + invokeCallback
        )), array.push(callback)), 1;
      invokeCallback = 0;
      var nextNamePrefix = "" === nameSoFar ? "." : nameSoFar + ":";
      if (isArrayImpl(children))
        for (var i = 0; i < children.length; i++)
          nameSoFar = children[i], type = nextNamePrefix + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
            nameSoFar,
            array,
            escapedPrefix,
            type,
            callback
          );
      else if (i = getIteratorFn(children), "function" === typeof i)
        for (children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
          nameSoFar = nameSoFar.value, type = nextNamePrefix + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
            nameSoFar,
            array,
            escapedPrefix,
            type,
            callback
          );
      else if ("object" === type) {
        if ("function" === typeof children.then)
          return mapIntoArray(
            resolveThenable(children),
            array,
            escapedPrefix,
            nameSoFar,
            callback
          );
        array = String(children);
        throw Error(
          "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
        );
      }
      return invokeCallback;
    }
    function mapChildren(children, func, context) {
      if (null == children) return children;
      var result = [], count = 0;
      mapIntoArray(children, result, "", "", function(child) {
        return func.call(context, child, count++);
      });
      return result;
    }
    function lazyInitializer(payload) {
      if (-1 === payload._status) {
        var ctor = payload._result, thenable = ctor();
        thenable.then(
          function(moduleObject) {
            if (0 === payload._status || -1 === payload._status)
              payload._status = 1, payload._result = moduleObject, void 0 === thenable.status && (thenable.status = "fulfilled", thenable.value = moduleObject);
          },
          function(error) {
            if (0 === payload._status || -1 === payload._status)
              payload._status = 2, payload._result = error, void 0 === thenable.status && (thenable.status = "rejected", thenable.reason = error);
          }
        );
        -1 === payload._status && (payload._status = 0, payload._result = thenable);
      }
      if (1 === payload._status) return payload._result.default;
      throw payload._result;
    }
    var reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
      if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
        var event = new window.ErrorEvent("error", {
          bubbles: true,
          cancelable: true,
          message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
          error
        });
        if (!window.dispatchEvent(event)) return;
      } else if ("object" === typeof process && "function" === typeof process.emit) {
        process.emit("uncaughtException", error);
        return;
      }
      console.error(error);
    };
    function startTransition(scope) {
      var prevTransition = ReactSharedInternals.T, currentTransition = {};
      currentTransition.types = null !== prevTransition ? prevTransition.types : null;
      ReactSharedInternals.T = currentTransition;
      try {
        var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
        null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
        "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && returnValue.then(noop, reportGlobalError);
      } catch (error) {
        reportGlobalError(error);
      } finally {
        null !== prevTransition && null !== currentTransition.types && (prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
      }
    }
    function addTransitionType(type) {
      var transition = ReactSharedInternals.T;
      if (null !== transition) {
        var transitionTypes = transition.types;
        null === transitionTypes ? transition.types = [type] : -1 === transitionTypes.indexOf(type) && transitionTypes.push(type);
      } else startTransition(addTransitionType.bind(null, type));
    }
    var Children = {
      map: mapChildren,
      forEach: function(children, forEachFunc, forEachContext) {
        mapChildren(
          children,
          function() {
            forEachFunc.apply(this, arguments);
          },
          forEachContext
        );
      },
      count: function(children) {
        var n = 0;
        mapChildren(children, function() {
          n++;
        });
        return n;
      },
      toArray: function(children) {
        return mapChildren(children, function(child) {
          return child;
        }) || [];
      },
      only: function(children) {
        if (!isValidElement(children))
          throw Error(
            "React.Children.only expected to receive a single React element child."
          );
        return children;
      }
    };
    exports2.Activity = REACT_ACTIVITY_TYPE;
    exports2.Children = Children;
    exports2.Component = Component;
    exports2.Fragment = REACT_FRAGMENT_TYPE;
    exports2.Profiler = REACT_PROFILER_TYPE;
    exports2.PureComponent = PureComponent;
    exports2.StrictMode = REACT_STRICT_MODE_TYPE;
    exports2.Suspense = REACT_SUSPENSE_TYPE;
    exports2.ViewTransition = REACT_VIEW_TRANSITION_TYPE;
    exports2.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
    exports2.__COMPILER_RUNTIME = {
      __proto__: null,
      c: function(size) {
        return ReactSharedInternals.H.useMemoCache(size);
      }
    };
    exports2.addTransitionType = addTransitionType;
    exports2.cache = function(fn) {
      return function() {
        return fn.apply(null, arguments);
      };
    };
    exports2.cacheSignal = function() {
      return null;
    };
    exports2.cloneElement = function(element, config, children) {
      if (null === element || void 0 === element)
        throw Error(
          "The argument must be a React element, but you passed " + element + "."
        );
      var props = assign({}, element.props), key = element.key;
      if (null != config)
        for (propName in void 0 !== config.key && (key = "" + config.key), config)
          !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
      var propName = arguments.length - 2;
      if (1 === propName) props.children = children;
      else if (1 < propName) {
        for (var childArray = Array(propName), i = 0; i < propName; i++)
          childArray[i] = arguments[i + 2];
        props.children = childArray;
      }
      return ReactElement(element.type, key, props);
    };
    exports2.createContext = function(defaultValue) {
      defaultValue = {
        $$typeof: REACT_CONTEXT_TYPE,
        _currentValue: defaultValue,
        _currentValue2: defaultValue,
        _threadCount: 0,
        Provider: null,
        Consumer: null
      };
      defaultValue.Provider = defaultValue;
      defaultValue.Consumer = {
        $$typeof: REACT_CONSUMER_TYPE,
        _context: defaultValue
      };
      return defaultValue;
    };
    exports2.createElement = function(type, config, children) {
      var propName, props = {}, key = null;
      if (null != config)
        for (propName in void 0 !== config.key && (key = "" + config.key), config)
          hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (props[propName] = config[propName]);
      var childrenLength = arguments.length - 2;
      if (1 === childrenLength) props.children = children;
      else if (1 < childrenLength) {
        for (var childArray = Array(childrenLength), i = 0; i < childrenLength; i++)
          childArray[i] = arguments[i + 2];
        props.children = childArray;
      }
      if (type && type.defaultProps)
        for (propName in childrenLength = type.defaultProps, childrenLength)
          void 0 === props[propName] && (props[propName] = childrenLength[propName]);
      return ReactElement(type, key, props);
    };
    exports2.createRef = function() {
      return { current: null };
    };
    exports2.forwardRef = function(render) {
      return { $$typeof: REACT_FORWARD_REF_TYPE, render };
    };
    exports2.isValidElement = isValidElement;
    exports2.lazy = function(ctor) {
      return {
        $$typeof: REACT_LAZY_TYPE,
        _payload: { _status: -1, _result: ctor },
        _init: lazyInitializer
      };
    };
    exports2.memo = function(type, compare) {
      return {
        $$typeof: REACT_MEMO_TYPE,
        type,
        compare: void 0 === compare ? null : compare
      };
    };
    exports2.startTransition = startTransition;
    exports2.unstable_useCacheRefresh = function() {
      return ReactSharedInternals.H.useCacheRefresh();
    };
    exports2.use = function(usable) {
      return ReactSharedInternals.H.use(usable);
    };
    exports2.useActionState = function(action, initialState, permalink) {
      return ReactSharedInternals.H.useActionState(action, initialState, permalink);
    };
    exports2.useCallback = function(callback, deps) {
      return ReactSharedInternals.H.useCallback(callback, deps);
    };
    exports2.useContext = function(Context) {
      return ReactSharedInternals.H.useContext(Context);
    };
    exports2.useDebugValue = function() {
    };
    exports2.useDeferredValue = function(value, initialValue) {
      return ReactSharedInternals.H.useDeferredValue(value, initialValue);
    };
    exports2.useEffect = function(create, deps) {
      return ReactSharedInternals.H.useEffect(create, deps);
    };
    exports2.useEffectEvent = function(callback) {
      return ReactSharedInternals.H.useEffectEvent(callback);
    };
    exports2.useId = function() {
      return ReactSharedInternals.H.useId();
    };
    exports2.useImperativeHandle = function(ref, create, deps) {
      return ReactSharedInternals.H.useImperativeHandle(ref, create, deps);
    };
    exports2.useInsertionEffect = function(create, deps) {
      return ReactSharedInternals.H.useInsertionEffect(create, deps);
    };
    exports2.useLayoutEffect = function(create, deps) {
      return ReactSharedInternals.H.useLayoutEffect(create, deps);
    };
    exports2.useMemo = function(create, deps) {
      return ReactSharedInternals.H.useMemo(create, deps);
    };
    exports2.useOptimistic = function(passthrough, reducer) {
      return ReactSharedInternals.H.useOptimistic(passthrough, reducer);
    };
    exports2.useReducer = function(reducer, initialArg, init) {
      return ReactSharedInternals.H.useReducer(reducer, initialArg, init);
    };
    exports2.useRef = function(initialValue) {
      return ReactSharedInternals.H.useRef(initialValue);
    };
    exports2.useState = function(initialState) {
      return ReactSharedInternals.H.useState(initialState);
    };
    exports2.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
      return ReactSharedInternals.H.useSyncExternalStore(
        subscribe,
        getSnapshot,
        getServerSnapshot
      );
    };
    exports2.useTransition = function() {
      return ReactSharedInternals.H.useTransition();
    };
    exports2.version = "19.3.0";
  }
});

// node_modules/react/cjs/react.development.js
var require_react_development = __commonJS({
  "node_modules/react/cjs/react.development.js"(exports2, module2) {
    "use strict";
    "production" !== process.env.NODE_ENV && (function() {
      function defineDeprecationWarning(methodName, info) {
        Object.defineProperty(Component.prototype, methodName, {
          get: function() {
            console.warn(
              "%s(...) is deprecated in plain JavaScript React classes. %s",
              info[0],
              info[1]
            );
          }
        });
      }
      function getIteratorFn(maybeIterable) {
        if (null === maybeIterable || "object" !== typeof maybeIterable)
          return null;
        maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
        return "function" === typeof maybeIterable ? maybeIterable : null;
      }
      function warnNoop(publicInstance, callerName) {
        publicInstance = (publicInstance = publicInstance.constructor) && (publicInstance.displayName || publicInstance.name) || "ReactClass";
        var warningKey = publicInstance + "." + callerName;
        didWarnStateUpdateForUnmountedComponent[warningKey] || (console.error(
          "Can't call %s on a component that is not yet mounted. This is a no-op, but it might indicate a bug in your application. Instead, assign to `this.state` directly or define a `state = {};` class property with the desired state in the %s component.",
          callerName,
          publicInstance
        ), didWarnStateUpdateForUnmountedComponent[warningKey] = true);
      }
      function Component(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function ComponentDummy() {
      }
      function PureComponent(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function noop() {
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
          case REACT_VIEW_TRANSITION_TYPE:
            return "ViewTransition";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function cloneAndReplaceKey(oldElement, newKey) {
        newKey = ReactElement(
          oldElement.type,
          newKey,
          oldElement.props,
          oldElement._owner,
          oldElement._debugStack,
          oldElement._debugTask
        );
        oldElement._store && (newKey._store.validated = oldElement._store.validated);
        return newKey;
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      function escape(key) {
        var escaperLookup = { "=": "=0", ":": "=2" };
        return "$" + key.replace(/[=:]/g, function(match) {
          return escaperLookup[match];
        });
      }
      function getElementKey(element, index) {
        return "object" === typeof element && null !== element && null != element.key ? (checkKeyStringCoercion(element.key), escape("" + element.key)) : index.toString(36);
      }
      function resolveThenable(thenable) {
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
          default:
            switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
              function(fulfilledValue) {
                "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
              },
              function(error) {
                "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            )), thenable.status) {
              case "fulfilled":
                return thenable.value;
              case "rejected":
                throw thenable.reason;
            }
        }
        throw thenable;
      }
      function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
        var type = typeof children;
        if ("undefined" === type || "boolean" === type) children = null;
        var invokeCallback = false;
        if (null === children) invokeCallback = true;
        else
          switch (type) {
            case "bigint":
            case "string":
            case "number":
              invokeCallback = true;
              break;
            case "object":
              switch (children.$$typeof) {
                case REACT_ELEMENT_TYPE:
                case REACT_PORTAL_TYPE:
                  invokeCallback = true;
                  break;
                case REACT_LAZY_TYPE:
                  return invokeCallback = children._init, mapIntoArray(
                    invokeCallback(children._payload),
                    array,
                    escapedPrefix,
                    nameSoFar,
                    callback
                  );
              }
          }
        if (invokeCallback) {
          invokeCallback = children;
          callback = callback(invokeCallback);
          var childKey = "" === nameSoFar ? "." + getElementKey(invokeCallback, 0) : nameSoFar;
          isArrayImpl(callback) ? (escapedPrefix = "", null != childKey && (escapedPrefix = childKey.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
            return c;
          })) : null != callback && (isValidElement(callback) && (null != callback.key && (invokeCallback && invokeCallback.key === callback.key || checkKeyStringCoercion(callback.key)), escapedPrefix = cloneAndReplaceKey(
            callback,
            escapedPrefix + (null == callback.key || invokeCallback && invokeCallback.key === callback.key ? "" : ("" + callback.key).replace(
              userProvidedKeyEscapeRegex,
              "$&/"
            ) + "/") + childKey
          ), "" !== nameSoFar && null != invokeCallback && isValidElement(invokeCallback) && null == invokeCallback.key && invokeCallback._store && !invokeCallback._store.validated && (escapedPrefix._store.validated = 2), callback = escapedPrefix), array.push(callback));
          return 1;
        }
        invokeCallback = 0;
        childKey = "" === nameSoFar ? "." : nameSoFar + ":";
        if (isArrayImpl(children))
          for (var i = 0; i < children.length; i++)
            nameSoFar = children[i], type = childKey + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if (i = getIteratorFn(children), "function" === typeof i)
          for (i === children.entries && (didWarnAboutMaps || console.warn(
            "Using Maps as children is not supported. Use an array of keyed ReactElements instead."
          ), didWarnAboutMaps = true), children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
            nameSoFar = nameSoFar.value, type = childKey + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if ("object" === type) {
          if ("function" === typeof children.then)
            return mapIntoArray(
              resolveThenable(children),
              array,
              escapedPrefix,
              nameSoFar,
              callback
            );
          array = String(children);
          throw Error(
            "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
          );
        }
        return invokeCallback;
      }
      function mapChildren(children, func, context) {
        if (null == children) return children;
        var result = [], count = 0;
        mapIntoArray(children, result, "", "", function(child) {
          return func.call(context, child, count++);
        });
        return result;
      }
      function lazyInitializer(payload) {
        if (-1 === payload._status) {
          var resolveDebugValue = null, rejectDebugValue = null, ioInfo = payload._ioInfo;
          null != ioInfo && (ioInfo.start = ioInfo.end = performance.now(), ioInfo.value = new Promise(function(resolve, reject) {
            resolveDebugValue = resolve;
            rejectDebugValue = reject;
          }));
          ioInfo = payload._result;
          var thenable = ioInfo();
          thenable.then(
            function(moduleObject) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 1;
                payload._result = moduleObject;
                var _ioInfo = payload._ioInfo;
                if (null != _ioInfo) {
                  _ioInfo.end = performance.now();
                  var debugValue = null == moduleObject ? void 0 : moduleObject.default;
                  resolveDebugValue(debugValue);
                  _ioInfo.value.status = "fulfilled";
                  _ioInfo.value.value = debugValue;
                }
                void 0 === thenable.status && (thenable.status = "fulfilled", thenable.value = moduleObject);
              }
            },
            function(error) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 2;
                payload._result = error;
                var _ioInfo2 = payload._ioInfo;
                null != _ioInfo2 && (_ioInfo2.end = performance.now(), _ioInfo2.value.then(noop, noop), rejectDebugValue(error), _ioInfo2.value.status = "rejected", _ioInfo2.value.reason = error);
                void 0 === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            }
          );
          ioInfo = payload._ioInfo;
          if (null != ioInfo) {
            var displayName = thenable.displayName;
            "string" === typeof displayName && (ioInfo.name = displayName);
          }
          -1 === payload._status && (payload._status = 0, payload._result = thenable);
        }
        if (1 === payload._status)
          return ioInfo = payload._result, void 0 === ioInfo && console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))\n\nDid you accidentally put curly braces around the import?",
            ioInfo
          ), "default" in ioInfo || console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))",
            ioInfo
          ), ioInfo.default;
        throw payload._result;
      }
      function resolveDispatcher() {
        var dispatcher = ReactSharedInternals.H;
        null === dispatcher && console.error(
          "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem."
        );
        return dispatcher;
      }
      function releaseAsyncTransition() {
        ReactSharedInternals.asyncTransitions--;
      }
      function startTransition(scope) {
        var prevTransition = ReactSharedInternals.T, currentTransition = {};
        currentTransition.types = null !== prevTransition ? prevTransition.types : null;
        currentTransition._updatedFibers = /* @__PURE__ */ new Set();
        ReactSharedInternals.T = currentTransition;
        try {
          var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
          null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
          "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && (ReactSharedInternals.asyncTransitions++, returnValue.then(releaseAsyncTransition, releaseAsyncTransition), returnValue.then(noop, reportGlobalError));
        } catch (error) {
          reportGlobalError(error);
        } finally {
          null === prevTransition && currentTransition._updatedFibers && (scope = currentTransition._updatedFibers.size, currentTransition._updatedFibers.clear(), 10 < scope && console.warn(
            "Detected a large number of updates inside startTransition. If this is due to a subscription please re-write it to use React provided hooks. Otherwise concurrent mode guarantees are off the table."
          )), null !== prevTransition && null !== currentTransition.types && (null !== prevTransition.types && prevTransition.types !== currentTransition.types && console.error(
            "We expected inner Transitions to have transferred the outer types set and that you cannot add to the outer Transition while inside the inner.This is a bug in React."
          ), prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
        }
      }
      function addTransitionType(type) {
        var transition = ReactSharedInternals.T;
        if (null !== transition) {
          var transitionTypes = transition.types;
          null === transitionTypes ? transition.types = [type] : -1 === transitionTypes.indexOf(type) && transitionTypes.push(type);
        } else
          0 === ReactSharedInternals.asyncTransitions && console.error(
            "addTransitionType can only be called inside a `startTransition()` callback. It must be associated with a specific Transition."
          ), startTransition(addTransitionType.bind(null, type));
      }
      function enqueueTask(task) {
        if (null === enqueueTaskImpl)
          try {
            var requireString = ("require" + Math.random()).slice(0, 7);
            enqueueTaskImpl = (module2 && module2[requireString]).call(
              module2,
              "timers"
            ).setImmediate;
          } catch (_err) {
            enqueueTaskImpl = function(callback) {
              false === didWarnAboutMessageChannel && (didWarnAboutMessageChannel = true, "undefined" === typeof MessageChannel && console.error(
                "This browser does not have a MessageChannel implementation, so enqueuing tasks via await act(async () => ...) will fail. Please file an issue at https://github.com/facebook/react/issues if you encounter this warning."
              ));
              var channel = new MessageChannel();
              channel.port1.onmessage = callback;
              channel.port2.postMessage(void 0);
            };
          }
        return enqueueTaskImpl(task);
      }
      function aggregateErrors(errors) {
        return 1 < errors.length && "function" === typeof AggregateError ? new AggregateError(errors) : errors[0];
      }
      function popActScope(prevActQueue, prevActScopeDepth) {
        prevActScopeDepth !== actScopeDepth - 1 && console.error(
          "You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. "
        );
        actScopeDepth = prevActScopeDepth;
      }
      function recursivelyFlushAsyncActWork(returnValue, resolve, reject) {
        var queue = ReactSharedInternals.actQueue;
        if (null !== queue)
          if (0 !== queue.length)
            try {
              flushActQueue(queue);
              enqueueTask(function() {
                return recursivelyFlushAsyncActWork(returnValue, resolve, reject);
              });
              return;
            } catch (error) {
              ReactSharedInternals.thrownErrors.push(error);
            }
          else ReactSharedInternals.actQueue = null;
        0 < ReactSharedInternals.thrownErrors.length ? (queue = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, reject(queue)) : resolve(returnValue);
      }
      function flushActQueue(queue) {
        if (!isFlushing) {
          isFlushing = true;
          var i = 0;
          try {
            for (; i < queue.length; i++) {
              var callback = queue[i];
              do {
                ReactSharedInternals.didUsePromise = false;
                var continuation = callback(false);
                if (null !== continuation) {
                  if (ReactSharedInternals.didUsePromise) {
                    queue[i] = callback;
                    queue.splice(0, i);
                    return;
                  }
                  callback = continuation;
                } else break;
              } while (1);
            }
            queue.length = 0;
          } catch (error) {
            queue.splice(0, i + 1), ReactSharedInternals.thrownErrors.push(error);
          } finally {
            isFlushing = false;
          }
        }
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = /* @__PURE__ */ Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo"), REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity"), REACT_VIEW_TRANSITION_TYPE = /* @__PURE__ */ Symbol.for("react.view_transition"), MAYBE_ITERATOR_SYMBOL = Symbol.iterator, didWarnStateUpdateForUnmountedComponent = {}, ReactNoopUpdateQueue = {
        isMounted: function() {
          return false;
        },
        enqueueForceUpdate: function(publicInstance) {
          warnNoop(publicInstance, "forceUpdate");
        },
        enqueueReplaceState: function(publicInstance) {
          warnNoop(publicInstance, "replaceState");
        },
        enqueueSetState: function(publicInstance) {
          warnNoop(publicInstance, "setState");
        }
      }, assign = Object.assign, emptyObject = {};
      Object.freeze(emptyObject);
      Component.prototype.isReactComponent = {};
      Component.prototype.setState = function(partialState, callback) {
        if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
          throw Error(
            "takes an object of state variables to update or a function which returns an object of state variables."
          );
        this.updater.enqueueSetState(this, partialState, callback, "setState");
      };
      Component.prototype.forceUpdate = function(callback) {
        this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
      };
      var deprecatedAPIs = {
        isMounted: [
          "isMounted",
          "Instead, make sure to clean up subscriptions and pending requests in componentWillUnmount to prevent memory leaks."
        ],
        replaceState: [
          "replaceState",
          "Refactor your code to use setState instead (see https://github.com/facebook/react/issues/3236)."
        ]
      };
      for (fnName in deprecatedAPIs)
        deprecatedAPIs.hasOwnProperty(fnName) && defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
      ComponentDummy.prototype = Component.prototype;
      deprecatedAPIs = PureComponent.prototype = new ComponentDummy();
      deprecatedAPIs.constructor = PureComponent;
      assign(deprecatedAPIs, Component.prototype);
      deprecatedAPIs.isPureReactComponent = true;
      var isArrayImpl = Array.isArray, REACT_CLIENT_REFERENCE = /* @__PURE__ */ Symbol.for("react.client.reference"), ReactSharedInternals = {
        H: null,
        A: null,
        T: null,
        S: null,
        actQueue: null,
        asyncTransitions: 0,
        isBatchingLegacy: false,
        didScheduleLegacyUpdate: false,
        didUsePromise: false,
        thrownErrors: [],
        getCurrentStack: null,
        recentlyCreatedOwnerStacks: 0
      }, hasOwnProperty = Object.prototype.hasOwnProperty, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      deprecatedAPIs = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown, didWarnAboutOldJSXRuntime;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = deprecatedAPIs.react_stack_bottom_frame.bind(
        deprecatedAPIs,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutMaps = false, userProvidedKeyEscapeRegex = /\/+/g, reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
        if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
          var event = new window.ErrorEvent("error", {
            bubbles: true,
            cancelable: true,
            message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
            error
          });
          if (!window.dispatchEvent(event)) return;
        } else if ("object" === typeof process && "function" === typeof process.emit) {
          process.emit("uncaughtException", error);
          return;
        }
        console.error(error);
      }, didWarnAboutMessageChannel = false, enqueueTaskImpl = null, actScopeDepth = 0, didWarnNoAwaitAct = false, isFlushing = false, queueSeveralMicrotasks = "function" === typeof queueMicrotask ? function(callback) {
        queueMicrotask(function() {
          return queueMicrotask(callback);
        });
      } : enqueueTask;
      deprecatedAPIs = Object.freeze({
        __proto__: null,
        c: function(size) {
          return resolveDispatcher().useMemoCache(size);
        }
      });
      var fnName = {
        map: mapChildren,
        forEach: function(children, forEachFunc, forEachContext) {
          mapChildren(
            children,
            function() {
              forEachFunc.apply(this, arguments);
            },
            forEachContext
          );
        },
        count: function(children) {
          var n = 0;
          mapChildren(children, function() {
            n++;
          });
          return n;
        },
        toArray: function(children) {
          return mapChildren(children, function(child) {
            return child;
          }) || [];
        },
        only: function(children) {
          if (!isValidElement(children))
            throw Error(
              "React.Children.only expected to receive a single React element child."
            );
          return children;
        }
      };
      exports2.Activity = REACT_ACTIVITY_TYPE;
      exports2.Children = fnName;
      exports2.Component = Component;
      exports2.Fragment = REACT_FRAGMENT_TYPE;
      exports2.Profiler = REACT_PROFILER_TYPE;
      exports2.PureComponent = PureComponent;
      exports2.StrictMode = REACT_STRICT_MODE_TYPE;
      exports2.Suspense = REACT_SUSPENSE_TYPE;
      exports2.ViewTransition = REACT_VIEW_TRANSITION_TYPE;
      exports2.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
      exports2.__COMPILER_RUNTIME = deprecatedAPIs;
      exports2.act = function(callback) {
        var prevActQueue = ReactSharedInternals.actQueue, prevActScopeDepth = actScopeDepth;
        actScopeDepth++;
        var queue = ReactSharedInternals.actQueue = null !== prevActQueue ? prevActQueue : [], didAwaitActCall = false;
        try {
          var result = callback();
        } catch (error) {
          ReactSharedInternals.thrownErrors.push(error);
        }
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw popActScope(prevActQueue, prevActScopeDepth), callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        if (null !== result && "object" === typeof result && "function" === typeof result.then) {
          var thenable = result;
          queueSeveralMicrotasks(function() {
            didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
              "You called act(async () => ...) without await. This could lead to unexpected testing behaviour, interleaving multiple act calls and mixing their scopes. You should - await act(async () => ...);"
            ));
          });
          return {
            then: function(resolve, reject) {
              didAwaitActCall = true;
              thenable.then(
                function(returnValue) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  if (0 === prevActScopeDepth) {
                    try {
                      flushActQueue(queue), enqueueTask(function() {
                        return recursivelyFlushAsyncActWork(
                          returnValue,
                          resolve,
                          reject
                        );
                      });
                    } catch (error$0) {
                      ReactSharedInternals.thrownErrors.push(error$0);
                    }
                    if (0 < ReactSharedInternals.thrownErrors.length) {
                      var _thrownError = aggregateErrors(
                        ReactSharedInternals.thrownErrors
                      );
                      ReactSharedInternals.thrownErrors.length = 0;
                      reject(_thrownError);
                    }
                  } else resolve(returnValue);
                },
                function(error) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  0 < ReactSharedInternals.thrownErrors.length ? (error = aggregateErrors(
                    ReactSharedInternals.thrownErrors
                  ), ReactSharedInternals.thrownErrors.length = 0, reject(error)) : reject(error);
                }
              );
            }
          };
        }
        var returnValue$jscomp$0 = result;
        popActScope(prevActQueue, prevActScopeDepth);
        0 === prevActScopeDepth && (flushActQueue(queue), 0 !== queue.length && queueSeveralMicrotasks(function() {
          didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
            "A component suspended inside an `act` scope, but the `act` call was not awaited. When testing React components that depend on asynchronous data, you must await the result:\n\nawait act(() => ...)"
          ));
        }), ReactSharedInternals.actQueue = null);
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        return {
          then: function(resolve, reject) {
            didAwaitActCall = true;
            0 === prevActScopeDepth ? (ReactSharedInternals.actQueue = queue, enqueueTask(function() {
              return recursivelyFlushAsyncActWork(
                returnValue$jscomp$0,
                resolve,
                reject
              );
            })) : resolve(returnValue$jscomp$0);
          }
        };
      };
      exports2.addTransitionType = addTransitionType;
      exports2.cache = function(fn) {
        return function() {
          return fn.apply(null, arguments);
        };
      };
      exports2.cacheSignal = function() {
        return null;
      };
      exports2.captureOwnerStack = function() {
        var getCurrentStack = ReactSharedInternals.getCurrentStack;
        return null === getCurrentStack ? null : getCurrentStack();
      };
      exports2.cloneElement = function(element, config, children) {
        if (null === element || void 0 === element)
          throw Error(
            "The argument must be a React element, but you passed " + element + "."
          );
        var props = assign({}, element.props), key = element.key, owner = element._owner;
        if (null != config) {
          var JSCompiler_inline_result;
          a: {
            if (hasOwnProperty.call(config, "ref") && (JSCompiler_inline_result = Object.getOwnPropertyDescriptor(
              config,
              "ref"
            ).get) && JSCompiler_inline_result.isReactWarning) {
              JSCompiler_inline_result = false;
              break a;
            }
            JSCompiler_inline_result = void 0 !== config.ref;
          }
          JSCompiler_inline_result && (owner = getOwner());
          hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key);
          for (propName in config)
            !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
        }
        var propName = arguments.length - 2;
        if (1 === propName) props.children = children;
        else if (1 < propName) {
          JSCompiler_inline_result = Array(propName);
          for (var i = 0; i < propName; i++)
            JSCompiler_inline_result[i] = arguments[i + 2];
          props.children = JSCompiler_inline_result;
        }
        props = ReactElement(
          element.type,
          key,
          props,
          owner,
          element._debugStack,
          element._debugTask
        );
        for (key = 2; key < arguments.length; key++)
          validateChildKeys(arguments[key]);
        return props;
      };
      exports2.createContext = function(defaultValue) {
        defaultValue = {
          $$typeof: REACT_CONTEXT_TYPE,
          _currentValue: defaultValue,
          _currentValue2: defaultValue,
          _threadCount: 0,
          Provider: null,
          Consumer: null
        };
        defaultValue.Provider = defaultValue;
        defaultValue.Consumer = {
          $$typeof: REACT_CONSUMER_TYPE,
          _context: defaultValue
        };
        defaultValue._currentRenderer = null;
        defaultValue._currentRenderer2 = null;
        return defaultValue;
      };
      exports2.createElement = function(type, config, children) {
        for (var i = 2; i < arguments.length; i++)
          validateChildKeys(arguments[i]);
        var propName;
        i = {};
        var key = null;
        if (null != config)
          for (propName in didWarnAboutOldJSXRuntime || !("__self" in config) || "key" in config || (didWarnAboutOldJSXRuntime = true, console.warn(
            "Your app (or one of its dependencies) is using an outdated JSX transform. Update to the modern JSX transform for faster performance: https://react.dev/link/new-jsx-transform"
          )), hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key), config)
            hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (i[propName] = config[propName]);
        var childrenLength = arguments.length - 2;
        if (1 === childrenLength) i.children = children;
        else if (1 < childrenLength) {
          for (var childArray = Array(childrenLength), _i = 0; _i < childrenLength; _i++)
            childArray[_i] = arguments[_i + 2];
          Object.freeze && Object.freeze(childArray);
          i.children = childArray;
        }
        if (type && type.defaultProps)
          for (propName in childrenLength = type.defaultProps, childrenLength)
            void 0 === i[propName] && (i[propName] = childrenLength[propName]);
        key && defineKeyPropWarningGetter(
          i,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        (propName = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++) ? (childArray = Error.stackTraceLimit, Error.stackTraceLimit = 10, childrenLength = Error("react-stack-top-frame"), Error.stackTraceLimit = childArray) : childrenLength = unknownOwnerDebugStack;
        return ReactElement(
          type,
          key,
          i,
          getOwner(),
          childrenLength,
          propName ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports2.createRef = function() {
        var refObject = { current: null };
        Object.seal(refObject);
        return refObject;
      };
      exports2.forwardRef = function(render) {
        null != render && render.$$typeof === REACT_MEMO_TYPE ? console.error(
          "forwardRef requires a render function but received a `memo` component. Instead of forwardRef(memo(...)), use memo(forwardRef(...))."
        ) : "function" !== typeof render ? console.error(
          "forwardRef requires a render function but was given %s.",
          null === render ? "null" : typeof render
        ) : 0 !== render.length && 2 !== render.length && console.error(
          "forwardRef render functions accept exactly two parameters: props and ref. %s",
          1 === render.length ? "Did you forget to use the ref parameter?" : "Any additional parameter will be undefined."
        );
        null != render && null != render.defaultProps && console.error(
          "forwardRef render functions do not support defaultProps. Did you accidentally pass a React component?"
        );
        var elementType = { $$typeof: REACT_FORWARD_REF_TYPE, render }, ownName;
        Object.defineProperty(elementType, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            render.name || render.displayName || (Object.defineProperty(render, "name", { value: name }), render.displayName = name);
          }
        });
        return elementType;
      };
      exports2.isValidElement = isValidElement;
      exports2.lazy = function(ctor) {
        ctor = { _status: -1, _result: ctor };
        var lazyType = {
          $$typeof: REACT_LAZY_TYPE,
          _payload: ctor,
          _init: lazyInitializer
        }, ioInfo = {
          name: "lazy",
          start: -1,
          end: -1,
          value: null,
          owner: null,
          debugStack: Error("react-stack-top-frame"),
          debugTask: console.createTask ? console.createTask("lazy()") : null
        };
        ctor._ioInfo = ioInfo;
        lazyType._debugInfo = [{ awaited: ioInfo }];
        return lazyType;
      };
      exports2.memo = function(type, compare) {
        null == type && console.error(
          "memo: The first argument must be a component. Instead received: %s",
          null === type ? "null" : typeof type
        );
        compare = {
          $$typeof: REACT_MEMO_TYPE,
          type,
          compare: void 0 === compare ? null : compare
        };
        var ownName;
        Object.defineProperty(compare, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            type.name || type.displayName || (Object.defineProperty(type, "name", { value: name }), type.displayName = name);
          }
        });
        return compare;
      };
      exports2.startTransition = startTransition;
      exports2.unstable_useCacheRefresh = function() {
        return resolveDispatcher().useCacheRefresh();
      };
      exports2.use = function(usable) {
        return resolveDispatcher().use(usable);
      };
      exports2.useActionState = function(action, initialState, permalink) {
        return resolveDispatcher().useActionState(
          action,
          initialState,
          permalink
        );
      };
      exports2.useCallback = function(callback, deps) {
        return resolveDispatcher().useCallback(callback, deps);
      };
      exports2.useContext = function(Context) {
        var dispatcher = resolveDispatcher();
        Context.$$typeof === REACT_CONSUMER_TYPE && console.error(
          "Calling useContext(Context.Consumer) is not supported and will cause bugs. Did you mean to call useContext(Context) instead?"
        );
        return dispatcher.useContext(Context);
      };
      exports2.useDebugValue = function(value, formatterFn) {
        return resolveDispatcher().useDebugValue(value, formatterFn);
      };
      exports2.useDeferredValue = function(value, initialValue) {
        return resolveDispatcher().useDeferredValue(value, initialValue);
      };
      exports2.useEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useEffect(create, deps);
      };
      exports2.useEffectEvent = function(callback) {
        return resolveDispatcher().useEffectEvent(callback);
      };
      exports2.useId = function() {
        return resolveDispatcher().useId();
      };
      exports2.useImperativeHandle = function(ref, create, deps) {
        return resolveDispatcher().useImperativeHandle(ref, create, deps);
      };
      exports2.useInsertionEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useInsertionEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useInsertionEffect(create, deps);
      };
      exports2.useLayoutEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useLayoutEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useLayoutEffect(create, deps);
      };
      exports2.useMemo = function(create, deps) {
        return resolveDispatcher().useMemo(create, deps);
      };
      exports2.useOptimistic = function(passthrough, reducer) {
        return resolveDispatcher().useOptimistic(passthrough, reducer);
      };
      exports2.useReducer = function(reducer, initialArg, init) {
        return resolveDispatcher().useReducer(reducer, initialArg, init);
      };
      exports2.useRef = function(initialValue) {
        return resolveDispatcher().useRef(initialValue);
      };
      exports2.useState = function(initialState) {
        return resolveDispatcher().useState(initialState);
      };
      exports2.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
        return resolveDispatcher().useSyncExternalStore(
          subscribe,
          getSnapshot,
          getServerSnapshot
        );
      };
      exports2.useTransition = function() {
        return resolveDispatcher().useTransition();
      };
      exports2.version = "19.3.0";
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// node_modules/react/index.js
var require_react = __commonJS({
  "node_modules/react/index.js"(exports2, module2) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module2.exports = require_react_production();
    } else {
      module2.exports = require_react_development();
    }
  }
});

// node_modules/qrcode/lib/can-promise.js
var require_can_promise = __commonJS({
  "node_modules/qrcode/lib/can-promise.js"(exports2, module2) {
    module2.exports = function() {
      return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
    };
  }
});

// node_modules/qrcode/lib/core/utils.js
var require_utils = __commonJS({
  "node_modules/qrcode/lib/core/utils.js"(exports2) {
    var toSJISFunction;
    var CODEWORDS_COUNT = [
      0,
      // Not used
      26,
      44,
      70,
      100,
      134,
      172,
      196,
      242,
      292,
      346,
      404,
      466,
      532,
      581,
      655,
      733,
      815,
      901,
      991,
      1085,
      1156,
      1258,
      1364,
      1474,
      1588,
      1706,
      1828,
      1921,
      2051,
      2185,
      2323,
      2465,
      2611,
      2761,
      2876,
      3034,
      3196,
      3362,
      3532,
      3706
    ];
    exports2.getSymbolSize = function getSymbolSize(version) {
      if (!version) throw new Error('"version" cannot be null or undefined');
      if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40');
      return version * 4 + 17;
    };
    exports2.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
      return CODEWORDS_COUNT[version];
    };
    exports2.getBCHDigit = function(data) {
      let digit = 0;
      while (data !== 0) {
        digit++;
        data >>>= 1;
      }
      return digit;
    };
    exports2.setToSJISFunction = function setToSJISFunction(f) {
      if (typeof f !== "function") {
        throw new Error('"toSJISFunc" is not a valid function.');
      }
      toSJISFunction = f;
    };
    exports2.isKanjiModeEnabled = function() {
      return typeof toSJISFunction !== "undefined";
    };
    exports2.toSJIS = function toSJIS(kanji) {
      return toSJISFunction(kanji);
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-level.js
var require_error_correction_level = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-level.js"(exports2) {
    exports2.L = { bit: 1 };
    exports2.M = { bit: 0 };
    exports2.Q = { bit: 3 };
    exports2.H = { bit: 2 };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "l":
        case "low":
          return exports2.L;
        case "m":
        case "medium":
          return exports2.M;
        case "q":
        case "quartile":
          return exports2.Q;
        case "h":
        case "high":
          return exports2.H;
        default:
          throw new Error("Unknown EC Level: " + string);
      }
    }
    exports2.isValid = function isValid(level) {
      return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
    };
    exports2.from = function from(value, defaultValue) {
      if (exports2.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/bit-buffer.js
var require_bit_buffer = __commonJS({
  "node_modules/qrcode/lib/core/bit-buffer.js"(exports2, module2) {
    function BitBuffer() {
      this.buffer = [];
      this.length = 0;
    }
    BitBuffer.prototype = {
      get: function(index) {
        const bufIndex = Math.floor(index / 8);
        return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
      },
      put: function(num, length) {
        for (let i = 0; i < length; i++) {
          this.putBit((num >>> length - i - 1 & 1) === 1);
        }
      },
      getLengthInBits: function() {
        return this.length;
      },
      putBit: function(bit) {
        const bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) {
          this.buffer.push(0);
        }
        if (bit) {
          this.buffer[bufIndex] |= 128 >>> this.length % 8;
        }
        this.length++;
      }
    };
    module2.exports = BitBuffer;
  }
});

// node_modules/qrcode/lib/core/bit-matrix.js
var require_bit_matrix = __commonJS({
  "node_modules/qrcode/lib/core/bit-matrix.js"(exports2, module2) {
    function BitMatrix(size) {
      if (!size || size < 1) {
        throw new Error("BitMatrix size must be defined and greater than 0");
      }
      this.size = size;
      this.data = new Uint8Array(size * size);
      this.reservedBit = new Uint8Array(size * size);
    }
    BitMatrix.prototype.set = function(row, col, value, reserved) {
      const index = row * this.size + col;
      this.data[index] = value;
      if (reserved) this.reservedBit[index] = true;
    };
    BitMatrix.prototype.get = function(row, col) {
      return this.data[row * this.size + col];
    };
    BitMatrix.prototype.xor = function(row, col, value) {
      this.data[row * this.size + col] ^= value;
    };
    BitMatrix.prototype.isReserved = function(row, col) {
      return this.reservedBit[row * this.size + col];
    };
    module2.exports = BitMatrix;
  }
});

// node_modules/qrcode/lib/core/alignment-pattern.js
var require_alignment_pattern = __commonJS({
  "node_modules/qrcode/lib/core/alignment-pattern.js"(exports2) {
    var getSymbolSize = require_utils().getSymbolSize;
    exports2.getRowColCoords = function getRowColCoords(version) {
      if (version === 1) return [];
      const posCount = Math.floor(version / 7) + 2;
      const size = getSymbolSize(version);
      const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
      const positions = [size - 7];
      for (let i = 1; i < posCount - 1; i++) {
        positions[i] = positions[i - 1] - intervals;
      }
      positions.push(6);
      return positions.reverse();
    };
    exports2.getPositions = function getPositions(version) {
      const coords = [];
      const pos = exports2.getRowColCoords(version);
      const posLength = pos.length;
      for (let i = 0; i < posLength; i++) {
        for (let j = 0; j < posLength; j++) {
          if (i === 0 && j === 0 || // top-left
          i === 0 && j === posLength - 1 || // bottom-left
          i === posLength - 1 && j === 0) {
            continue;
          }
          coords.push([pos[i], pos[j]]);
        }
      }
      return coords;
    };
  }
});

// node_modules/qrcode/lib/core/finder-pattern.js
var require_finder_pattern = __commonJS({
  "node_modules/qrcode/lib/core/finder-pattern.js"(exports2) {
    var getSymbolSize = require_utils().getSymbolSize;
    var FINDER_PATTERN_SIZE = 7;
    exports2.getPositions = function getPositions(version) {
      const size = getSymbolSize(version);
      return [
        // top-left
        [0, 0],
        // top-right
        [size - FINDER_PATTERN_SIZE, 0],
        // bottom-left
        [0, size - FINDER_PATTERN_SIZE]
      ];
    };
  }
});

// node_modules/qrcode/lib/core/mask-pattern.js
var require_mask_pattern = __commonJS({
  "node_modules/qrcode/lib/core/mask-pattern.js"(exports2) {
    exports2.Patterns = {
      PATTERN000: 0,
      PATTERN001: 1,
      PATTERN010: 2,
      PATTERN011: 3,
      PATTERN100: 4,
      PATTERN101: 5,
      PATTERN110: 6,
      PATTERN111: 7
    };
    var PenaltyScores = {
      N1: 3,
      N2: 3,
      N3: 40,
      N4: 10
    };
    exports2.isValid = function isValid(mask) {
      return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
    };
    exports2.from = function from(value) {
      return exports2.isValid(value) ? parseInt(value, 10) : void 0;
    };
    exports2.getPenaltyN1 = function getPenaltyN1(data) {
      const size = data.size;
      let points = 0;
      let sameCountCol = 0;
      let sameCountRow = 0;
      let lastCol = null;
      let lastRow = null;
      for (let row = 0; row < size; row++) {
        sameCountCol = sameCountRow = 0;
        lastCol = lastRow = null;
        for (let col = 0; col < size; col++) {
          let module3 = data.get(row, col);
          if (module3 === lastCol) {
            sameCountCol++;
          } else {
            if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
            lastCol = module3;
            sameCountCol = 1;
          }
          module3 = data.get(col, row);
          if (module3 === lastRow) {
            sameCountRow++;
          } else {
            if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
            lastRow = module3;
            sameCountRow = 1;
          }
        }
        if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
        if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
      }
      return points;
    };
    exports2.getPenaltyN2 = function getPenaltyN2(data) {
      const size = data.size;
      let points = 0;
      for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
          const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
          if (last === 4 || last === 0) points++;
        }
      }
      return points * PenaltyScores.N2;
    };
    exports2.getPenaltyN3 = function getPenaltyN3(data) {
      const size = data.size;
      let points = 0;
      let bitsCol = 0;
      let bitsRow = 0;
      for (let row = 0; row < size; row++) {
        bitsCol = bitsRow = 0;
        for (let col = 0; col < size; col++) {
          bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
          if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
          bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
          if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
        }
      }
      return points * PenaltyScores.N3;
    };
    exports2.getPenaltyN4 = function getPenaltyN4(data) {
      let darkCount = 0;
      const modulesCount = data.data.length;
      for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
      const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
      return k * PenaltyScores.N4;
    };
    function getMaskAt(maskPattern, i, j) {
      switch (maskPattern) {
        case exports2.Patterns.PATTERN000:
          return (i + j) % 2 === 0;
        case exports2.Patterns.PATTERN001:
          return i % 2 === 0;
        case exports2.Patterns.PATTERN010:
          return j % 3 === 0;
        case exports2.Patterns.PATTERN011:
          return (i + j) % 3 === 0;
        case exports2.Patterns.PATTERN100:
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
        case exports2.Patterns.PATTERN101:
          return i * j % 2 + i * j % 3 === 0;
        case exports2.Patterns.PATTERN110:
          return (i * j % 2 + i * j % 3) % 2 === 0;
        case exports2.Patterns.PATTERN111:
          return (i * j % 3 + (i + j) % 2) % 2 === 0;
        default:
          throw new Error("bad maskPattern:" + maskPattern);
      }
    }
    exports2.applyMask = function applyMask(pattern, data) {
      const size = data.size;
      for (let col = 0; col < size; col++) {
        for (let row = 0; row < size; row++) {
          if (data.isReserved(row, col)) continue;
          data.xor(row, col, getMaskAt(pattern, row, col));
        }
      }
    };
    exports2.getBestMask = function getBestMask(data, setupFormatFunc) {
      const numPatterns = Object.keys(exports2.Patterns).length;
      let bestPattern = 0;
      let lowerPenalty = Infinity;
      for (let p = 0; p < numPatterns; p++) {
        setupFormatFunc(p);
        exports2.applyMask(p, data);
        const penalty = exports2.getPenaltyN1(data) + exports2.getPenaltyN2(data) + exports2.getPenaltyN3(data) + exports2.getPenaltyN4(data);
        exports2.applyMask(p, data);
        if (penalty < lowerPenalty) {
          lowerPenalty = penalty;
          bestPattern = p;
        }
      }
      return bestPattern;
    };
  }
});

// node_modules/qrcode/lib/core/error-correction-code.js
var require_error_correction_code = __commonJS({
  "node_modules/qrcode/lib/core/error-correction-code.js"(exports2) {
    var ECLevel = require_error_correction_level();
    var EC_BLOCKS_TABLE = [
      // L  M  Q  H
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      2,
      2,
      1,
      2,
      2,
      4,
      1,
      2,
      4,
      4,
      2,
      4,
      4,
      4,
      2,
      4,
      6,
      5,
      2,
      4,
      6,
      6,
      2,
      5,
      8,
      8,
      4,
      5,
      8,
      8,
      4,
      5,
      8,
      11,
      4,
      8,
      10,
      11,
      4,
      9,
      12,
      16,
      4,
      9,
      16,
      16,
      6,
      10,
      12,
      18,
      6,
      10,
      17,
      16,
      6,
      11,
      16,
      19,
      6,
      13,
      18,
      21,
      7,
      14,
      21,
      25,
      8,
      16,
      20,
      25,
      8,
      17,
      23,
      25,
      9,
      17,
      23,
      34,
      9,
      18,
      25,
      30,
      10,
      20,
      27,
      32,
      12,
      21,
      29,
      35,
      12,
      23,
      34,
      37,
      12,
      25,
      34,
      40,
      13,
      26,
      35,
      42,
      14,
      28,
      38,
      45,
      15,
      29,
      40,
      48,
      16,
      31,
      43,
      51,
      17,
      33,
      45,
      54,
      18,
      35,
      48,
      57,
      19,
      37,
      51,
      60,
      19,
      38,
      53,
      63,
      20,
      40,
      56,
      66,
      21,
      43,
      59,
      70,
      22,
      45,
      62,
      74,
      24,
      47,
      65,
      77,
      25,
      49,
      68,
      81
    ];
    var EC_CODEWORDS_TABLE = [
      // L  M  Q  H
      7,
      10,
      13,
      17,
      10,
      16,
      22,
      28,
      15,
      26,
      36,
      44,
      20,
      36,
      52,
      64,
      26,
      48,
      72,
      88,
      36,
      64,
      96,
      112,
      40,
      72,
      108,
      130,
      48,
      88,
      132,
      156,
      60,
      110,
      160,
      192,
      72,
      130,
      192,
      224,
      80,
      150,
      224,
      264,
      96,
      176,
      260,
      308,
      104,
      198,
      288,
      352,
      120,
      216,
      320,
      384,
      132,
      240,
      360,
      432,
      144,
      280,
      408,
      480,
      168,
      308,
      448,
      532,
      180,
      338,
      504,
      588,
      196,
      364,
      546,
      650,
      224,
      416,
      600,
      700,
      224,
      442,
      644,
      750,
      252,
      476,
      690,
      816,
      270,
      504,
      750,
      900,
      300,
      560,
      810,
      960,
      312,
      588,
      870,
      1050,
      336,
      644,
      952,
      1110,
      360,
      700,
      1020,
      1200,
      390,
      728,
      1050,
      1260,
      420,
      784,
      1140,
      1350,
      450,
      812,
      1200,
      1440,
      480,
      868,
      1290,
      1530,
      510,
      924,
      1350,
      1620,
      540,
      980,
      1440,
      1710,
      570,
      1036,
      1530,
      1800,
      570,
      1064,
      1590,
      1890,
      600,
      1120,
      1680,
      1980,
      630,
      1204,
      1770,
      2100,
      660,
      1260,
      1860,
      2220,
      720,
      1316,
      1950,
      2310,
      750,
      1372,
      2040,
      2430
    ];
    exports2.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
    exports2.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case ECLevel.L:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
        case ECLevel.M:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
        case ECLevel.Q:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
        case ECLevel.H:
          return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
  }
});

// node_modules/qrcode/lib/core/galois-field.js
var require_galois_field = __commonJS({
  "node_modules/qrcode/lib/core/galois-field.js"(exports2) {
    var EXP_TABLE = new Uint8Array(512);
    var LOG_TABLE = new Uint8Array(256);
    (function initTables() {
      let x = 1;
      for (let i = 0; i < 255; i++) {
        EXP_TABLE[i] = x;
        LOG_TABLE[x] = i;
        x <<= 1;
        if (x & 256) {
          x ^= 285;
        }
      }
      for (let i = 255; i < 512; i++) {
        EXP_TABLE[i] = EXP_TABLE[i - 255];
      }
    })();
    exports2.log = function log(n) {
      if (n < 1) throw new Error("log(" + n + ")");
      return LOG_TABLE[n];
    };
    exports2.exp = function exp(n) {
      return EXP_TABLE[n];
    };
    exports2.mul = function mul(x, y) {
      if (x === 0 || y === 0) return 0;
      return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
    };
  }
});

// node_modules/qrcode/lib/core/polynomial.js
var require_polynomial = __commonJS({
  "node_modules/qrcode/lib/core/polynomial.js"(exports2) {
    var GF = require_galois_field();
    exports2.mul = function mul(p1, p2) {
      const coeff = new Uint8Array(p1.length + p2.length - 1);
      for (let i = 0; i < p1.length; i++) {
        for (let j = 0; j < p2.length; j++) {
          coeff[i + j] ^= GF.mul(p1[i], p2[j]);
        }
      }
      return coeff;
    };
    exports2.mod = function mod(divident, divisor) {
      let result = new Uint8Array(divident);
      while (result.length - divisor.length >= 0) {
        const coeff = result[0];
        for (let i = 0; i < divisor.length; i++) {
          result[i] ^= GF.mul(divisor[i], coeff);
        }
        let offset = 0;
        while (offset < result.length && result[offset] === 0) offset++;
        result = result.slice(offset);
      }
      return result;
    };
    exports2.generateECPolynomial = function generateECPolynomial(degree) {
      let poly = new Uint8Array([1]);
      for (let i = 0; i < degree; i++) {
        poly = exports2.mul(poly, new Uint8Array([1, GF.exp(i)]));
      }
      return poly;
    };
  }
});

// node_modules/qrcode/lib/core/reed-solomon-encoder.js
var require_reed_solomon_encoder = __commonJS({
  "node_modules/qrcode/lib/core/reed-solomon-encoder.js"(exports2, module2) {
    var Polynomial = require_polynomial();
    function ReedSolomonEncoder(degree) {
      this.genPoly = void 0;
      this.degree = degree;
      if (this.degree) this.initialize(this.degree);
    }
    ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
      this.degree = degree;
      this.genPoly = Polynomial.generateECPolynomial(this.degree);
    };
    ReedSolomonEncoder.prototype.encode = function encode(data) {
      if (!this.genPoly) {
        throw new Error("Encoder not initialized");
      }
      const paddedData = new Uint8Array(data.length + this.degree);
      paddedData.set(data);
      const remainder = Polynomial.mod(paddedData, this.genPoly);
      const start = this.degree - remainder.length;
      if (start > 0) {
        const buff = new Uint8Array(this.degree);
        buff.set(remainder, start);
        return buff;
      }
      return remainder;
    };
    module2.exports = ReedSolomonEncoder;
  }
});

// node_modules/qrcode/lib/core/version-check.js
var require_version_check = __commonJS({
  "node_modules/qrcode/lib/core/version-check.js"(exports2) {
    exports2.isValid = function isValid(version) {
      return !isNaN(version) && version >= 1 && version <= 40;
    };
  }
});

// node_modules/qrcode/lib/core/regex.js
var require_regex = __commonJS({
  "node_modules/qrcode/lib/core/regex.js"(exports2) {
    var numeric = "[0-9]+";
    var alphanumeric = "[A-Z $%*+\\-./:]+";
    var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
    kanji = kanji.replace(/u/g, "\\u");
    var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
    exports2.KANJI = new RegExp(kanji, "g");
    exports2.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
    exports2.BYTE = new RegExp(byte, "g");
    exports2.NUMERIC = new RegExp(numeric, "g");
    exports2.ALPHANUMERIC = new RegExp(alphanumeric, "g");
    var TEST_KANJI = new RegExp("^" + kanji + "$");
    var TEST_NUMERIC = new RegExp("^" + numeric + "$");
    var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
    exports2.testKanji = function testKanji(str) {
      return TEST_KANJI.test(str);
    };
    exports2.testNumeric = function testNumeric(str) {
      return TEST_NUMERIC.test(str);
    };
    exports2.testAlphanumeric = function testAlphanumeric(str) {
      return TEST_ALPHANUMERIC.test(str);
    };
  }
});

// node_modules/qrcode/lib/core/mode.js
var require_mode = __commonJS({
  "node_modules/qrcode/lib/core/mode.js"(exports2) {
    var VersionCheck = require_version_check();
    var Regex = require_regex();
    exports2.NUMERIC = {
      id: "Numeric",
      bit: 1 << 0,
      ccBits: [10, 12, 14]
    };
    exports2.ALPHANUMERIC = {
      id: "Alphanumeric",
      bit: 1 << 1,
      ccBits: [9, 11, 13]
    };
    exports2.BYTE = {
      id: "Byte",
      bit: 1 << 2,
      ccBits: [8, 16, 16]
    };
    exports2.KANJI = {
      id: "Kanji",
      bit: 1 << 3,
      ccBits: [8, 10, 12]
    };
    exports2.MIXED = {
      bit: -1
    };
    exports2.getCharCountIndicator = function getCharCountIndicator(mode, version) {
      if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid version: " + version);
      }
      if (version >= 1 && version < 10) return mode.ccBits[0];
      else if (version < 27) return mode.ccBits[1];
      return mode.ccBits[2];
    };
    exports2.getBestModeForData = function getBestModeForData(dataStr) {
      if (Regex.testNumeric(dataStr)) return exports2.NUMERIC;
      else if (Regex.testAlphanumeric(dataStr)) return exports2.ALPHANUMERIC;
      else if (Regex.testKanji(dataStr)) return exports2.KANJI;
      else return exports2.BYTE;
    };
    exports2.toString = function toString(mode) {
      if (mode && mode.id) return mode.id;
      throw new Error("Invalid mode");
    };
    exports2.isValid = function isValid(mode) {
      return mode && mode.bit && mode.ccBits;
    };
    function fromString(string) {
      if (typeof string !== "string") {
        throw new Error("Param is not a string");
      }
      const lcStr = string.toLowerCase();
      switch (lcStr) {
        case "numeric":
          return exports2.NUMERIC;
        case "alphanumeric":
          return exports2.ALPHANUMERIC;
        case "kanji":
          return exports2.KANJI;
        case "byte":
          return exports2.BYTE;
        default:
          throw new Error("Unknown mode: " + string);
      }
    }
    exports2.from = function from(value, defaultValue) {
      if (exports2.isValid(value)) {
        return value;
      }
      try {
        return fromString(value);
      } catch (e) {
        return defaultValue;
      }
    };
  }
});

// node_modules/qrcode/lib/core/version.js
var require_version = __commonJS({
  "node_modules/qrcode/lib/core/version.js"(exports2) {
    var Utils = require_utils();
    var ECCode = require_error_correction_code();
    var ECLevel = require_error_correction_level();
    var Mode = require_mode();
    var VersionCheck = require_version_check();
    var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
    var G18_BCH = Utils.getBCHDigit(G18);
    function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        if (length <= exports2.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    function getReservedBitsCount(mode, version) {
      return Mode.getCharCountIndicator(mode, version) + 4;
    }
    function getTotalBitsFromDataArray(segments, version) {
      let totalBits = 0;
      segments.forEach(function(data) {
        const reservedBits = getReservedBitsCount(data.mode, version);
        totalBits += reservedBits + data.getBitsLength();
      });
      return totalBits;
    }
    function getBestVersionForMixedData(segments, errorCorrectionLevel) {
      for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
        const length = getTotalBitsFromDataArray(segments, currentVersion);
        if (length <= exports2.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
          return currentVersion;
        }
      }
      return void 0;
    }
    exports2.from = function from(value, defaultValue) {
      if (VersionCheck.isValid(value)) {
        return parseInt(value, 10);
      }
      return defaultValue;
    };
    exports2.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
      if (!VersionCheck.isValid(version)) {
        throw new Error("Invalid QR Code version");
      }
      if (typeof mode === "undefined") mode = Mode.BYTE;
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (mode === Mode.MIXED) return dataTotalCodewordsBits;
      const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
      switch (mode) {
        case Mode.NUMERIC:
          return Math.floor(usableBits / 10 * 3);
        case Mode.ALPHANUMERIC:
          return Math.floor(usableBits / 11 * 2);
        case Mode.KANJI:
          return Math.floor(usableBits / 13);
        case Mode.BYTE:
        default:
          return Math.floor(usableBits / 8);
      }
    };
    exports2.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
      let seg;
      const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
      if (Array.isArray(data)) {
        if (data.length > 1) {
          return getBestVersionForMixedData(data, ecl);
        }
        if (data.length === 0) {
          return 1;
        }
        seg = data[0];
      } else {
        seg = data;
      }
      return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
    };
    exports2.getEncodedBits = function getEncodedBits(version) {
      if (!VersionCheck.isValid(version) || version < 7) {
        throw new Error("Invalid QR Code version");
      }
      let d = version << 12;
      while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
        d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
      }
      return version << 12 | d;
    };
  }
});

// node_modules/qrcode/lib/core/format-info.js
var require_format_info = __commonJS({
  "node_modules/qrcode/lib/core/format-info.js"(exports2) {
    var Utils = require_utils();
    var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
    var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
    var G15_BCH = Utils.getBCHDigit(G15);
    exports2.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
      const data = errorCorrectionLevel.bit << 3 | mask;
      let d = data << 10;
      while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
        d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
      }
      return (data << 10 | d) ^ G15_MASK;
    };
  }
});

// node_modules/qrcode/lib/core/numeric-data.js
var require_numeric_data = __commonJS({
  "node_modules/qrcode/lib/core/numeric-data.js"(exports2, module2) {
    var Mode = require_mode();
    function NumericData(data) {
      this.mode = Mode.NUMERIC;
      this.data = data.toString();
    }
    NumericData.getBitsLength = function getBitsLength(length) {
      return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
    };
    NumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    NumericData.prototype.getBitsLength = function getBitsLength() {
      return NumericData.getBitsLength(this.data.length);
    };
    NumericData.prototype.write = function write(bitBuffer) {
      let i, group2, value;
      for (i = 0; i + 3 <= this.data.length; i += 3) {
        group2 = this.data.substr(i, 3);
        value = parseInt(group2, 10);
        bitBuffer.put(value, 10);
      }
      const remainingNum = this.data.length - i;
      if (remainingNum > 0) {
        group2 = this.data.substr(i);
        value = parseInt(group2, 10);
        bitBuffer.put(value, remainingNum * 3 + 1);
      }
    };
    module2.exports = NumericData;
  }
});

// node_modules/qrcode/lib/core/alphanumeric-data.js
var require_alphanumeric_data = __commonJS({
  "node_modules/qrcode/lib/core/alphanumeric-data.js"(exports2, module2) {
    var Mode = require_mode();
    var ALPHA_NUM_CHARS = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
      "Y",
      "Z",
      " ",
      "$",
      "%",
      "*",
      "+",
      "-",
      ".",
      "/",
      ":"
    ];
    function AlphanumericData(data) {
      this.mode = Mode.ALPHANUMERIC;
      this.data = data;
    }
    AlphanumericData.getBitsLength = function getBitsLength(length) {
      return 11 * Math.floor(length / 2) + 6 * (length % 2);
    };
    AlphanumericData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    AlphanumericData.prototype.getBitsLength = function getBitsLength() {
      return AlphanumericData.getBitsLength(this.data.length);
    };
    AlphanumericData.prototype.write = function write(bitBuffer) {
      let i;
      for (i = 0; i + 2 <= this.data.length; i += 2) {
        let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
        value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
        bitBuffer.put(value, 11);
      }
      if (this.data.length % 2) {
        bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
      }
    };
    module2.exports = AlphanumericData;
  }
});

// node_modules/qrcode/lib/core/byte-data.js
var require_byte_data = __commonJS({
  "node_modules/qrcode/lib/core/byte-data.js"(exports2, module2) {
    var Mode = require_mode();
    function ByteData(data) {
      this.mode = Mode.BYTE;
      if (typeof data === "string") {
        this.data = new TextEncoder().encode(data);
      } else {
        this.data = new Uint8Array(data);
      }
    }
    ByteData.getBitsLength = function getBitsLength(length) {
      return length * 8;
    };
    ByteData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    ByteData.prototype.getBitsLength = function getBitsLength() {
      return ByteData.getBitsLength(this.data.length);
    };
    ByteData.prototype.write = function(bitBuffer) {
      for (let i = 0, l = this.data.length; i < l; i++) {
        bitBuffer.put(this.data[i], 8);
      }
    };
    module2.exports = ByteData;
  }
});

// node_modules/qrcode/lib/core/kanji-data.js
var require_kanji_data = __commonJS({
  "node_modules/qrcode/lib/core/kanji-data.js"(exports2, module2) {
    var Mode = require_mode();
    var Utils = require_utils();
    function KanjiData(data) {
      this.mode = Mode.KANJI;
      this.data = data;
    }
    KanjiData.getBitsLength = function getBitsLength(length) {
      return length * 13;
    };
    KanjiData.prototype.getLength = function getLength() {
      return this.data.length;
    };
    KanjiData.prototype.getBitsLength = function getBitsLength() {
      return KanjiData.getBitsLength(this.data.length);
    };
    KanjiData.prototype.write = function(bitBuffer) {
      let i;
      for (i = 0; i < this.data.length; i++) {
        let value = Utils.toSJIS(this.data[i]);
        if (value >= 33088 && value <= 40956) {
          value -= 33088;
        } else if (value >= 57408 && value <= 60351) {
          value -= 49472;
        } else {
          throw new Error(
            "Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8"
          );
        }
        value = (value >>> 8 & 255) * 192 + (value & 255);
        bitBuffer.put(value, 13);
      }
    };
    module2.exports = KanjiData;
  }
});

// node_modules/dijkstrajs/dijkstra.js
var require_dijkstra = __commonJS({
  "node_modules/dijkstrajs/dijkstra.js"(exports2, module2) {
    "use strict";
    var dijkstra = {
      single_source_shortest_paths: function(graph, s, d) {
        var predecessors = {};
        var costs = {};
        costs[s] = 0;
        var open = dijkstra.PriorityQueue.make();
        open.push(s, 0);
        var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
        while (!open.empty()) {
          closest = open.pop();
          u = closest.value;
          cost_of_s_to_u = closest.cost;
          adjacent_nodes = graph[u] || {};
          for (v in adjacent_nodes) {
            if (adjacent_nodes.hasOwnProperty(v)) {
              cost_of_e = adjacent_nodes[v];
              cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
              cost_of_s_to_v = costs[v];
              first_visit = typeof costs[v] === "undefined";
              if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                costs[v] = cost_of_s_to_u_plus_cost_of_e;
                open.push(v, cost_of_s_to_u_plus_cost_of_e);
                predecessors[v] = u;
              }
            }
          }
        }
        if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
          var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
          throw new Error(msg);
        }
        return predecessors;
      },
      extract_shortest_path_from_predecessor_list: function(predecessors, d) {
        var nodes = [];
        var u = d;
        var predecessor;
        while (u) {
          nodes.push(u);
          predecessor = predecessors[u];
          u = predecessors[u];
        }
        nodes.reverse();
        return nodes;
      },
      find_path: function(graph, s, d) {
        var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
        return dijkstra.extract_shortest_path_from_predecessor_list(
          predecessors,
          d
        );
      },
      /**
       * A very naive priority queue implementation.
       */
      PriorityQueue: {
        make: function(opts) {
          var T = dijkstra.PriorityQueue, t = {}, key;
          opts = opts || {};
          for (key in T) {
            if (T.hasOwnProperty(key)) {
              t[key] = T[key];
            }
          }
          t.queue = [];
          t.sorter = opts.sorter || T.default_sorter;
          return t;
        },
        default_sorter: function(a, b) {
          return a.cost - b.cost;
        },
        /**
         * Add a new item to the queue and ensure the highest priority element
         * is at the front of the queue.
         */
        push: function(value, cost) {
          var item = { value, cost };
          this.queue.push(item);
          this.queue.sort(this.sorter);
        },
        /**
         * Return the highest priority element in the queue.
         */
        pop: function() {
          return this.queue.shift();
        },
        empty: function() {
          return this.queue.length === 0;
        }
      }
    };
    if (typeof module2 !== "undefined") {
      module2.exports = dijkstra;
    }
  }
});

// node_modules/qrcode/lib/core/segments.js
var require_segments = __commonJS({
  "node_modules/qrcode/lib/core/segments.js"(exports2) {
    var Mode = require_mode();
    var NumericData = require_numeric_data();
    var AlphanumericData = require_alphanumeric_data();
    var ByteData = require_byte_data();
    var KanjiData = require_kanji_data();
    var Regex = require_regex();
    var Utils = require_utils();
    var dijkstra = require_dijkstra();
    function getStringByteLength(str) {
      return unescape(encodeURIComponent(str)).length;
    }
    function getSegments(regex, mode, str) {
      const segments = [];
      let result;
      while ((result = regex.exec(str)) !== null) {
        segments.push({
          data: result[0],
          index: result.index,
          mode,
          length: result[0].length
        });
      }
      return segments;
    }
    function getSegmentsFromString(dataStr) {
      const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
      const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
      let byteSegs;
      let kanjiSegs;
      if (Utils.isKanjiModeEnabled()) {
        byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
        kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
      } else {
        byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
        kanjiSegs = [];
      }
      const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
      return segs.sort(function(s1, s2) {
        return s1.index - s2.index;
      }).map(function(obj) {
        return {
          data: obj.data,
          mode: obj.mode,
          length: obj.length
        };
      });
    }
    function getSegmentBitsLength(length, mode) {
      switch (mode) {
        case Mode.NUMERIC:
          return NumericData.getBitsLength(length);
        case Mode.ALPHANUMERIC:
          return AlphanumericData.getBitsLength(length);
        case Mode.KANJI:
          return KanjiData.getBitsLength(length);
        case Mode.BYTE:
          return ByteData.getBitsLength(length);
      }
    }
    function mergeSegments(segs) {
      return segs.reduce(function(acc, curr) {
        const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
        if (prevSeg && prevSeg.mode === curr.mode) {
          acc[acc.length - 1].data += curr.data;
          return acc;
        }
        acc.push(curr);
        return acc;
      }, []);
    }
    function buildNodes(segs) {
      const nodes = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        switch (seg.mode) {
          case Mode.NUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.ALPHANUMERIC:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: seg.length }
            ]);
            break;
          case Mode.KANJI:
            nodes.push([
              seg,
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
            break;
          case Mode.BYTE:
            nodes.push([
              { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
            ]);
        }
      }
      return nodes;
    }
    function buildGraph(nodes, version) {
      const table = {};
      const graph = { start: {} };
      let prevNodeIds = ["start"];
      for (let i = 0; i < nodes.length; i++) {
        const nodeGroup = nodes[i];
        const currentNodeIds = [];
        for (let j = 0; j < nodeGroup.length; j++) {
          const node = nodeGroup[j];
          const key = "" + i + j;
          currentNodeIds.push(key);
          table[key] = { node, lastCount: 0 };
          graph[key] = {};
          for (let n = 0; n < prevNodeIds.length; n++) {
            const prevNodeId = prevNodeIds[n];
            if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
              graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
              table[prevNodeId].lastCount += node.length;
            } else {
              if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
              graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
            }
          }
        }
        prevNodeIds = currentNodeIds;
      }
      for (let n = 0; n < prevNodeIds.length; n++) {
        graph[prevNodeIds[n]].end = 0;
      }
      return { map: graph, table };
    }
    function buildSingleSegment(data, modesHint) {
      let mode;
      const bestMode = Mode.getBestModeForData(data);
      mode = Mode.from(modesHint, bestMode);
      if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
        throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
      }
      if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
        mode = Mode.BYTE;
      }
      switch (mode) {
        case Mode.NUMERIC:
          return new NumericData(data);
        case Mode.ALPHANUMERIC:
          return new AlphanumericData(data);
        case Mode.KANJI:
          return new KanjiData(data);
        case Mode.BYTE:
          return new ByteData(data);
      }
    }
    exports2.fromArray = function fromArray(array) {
      return array.reduce(function(acc, seg) {
        if (typeof seg === "string") {
          acc.push(buildSingleSegment(seg, null));
        } else if (seg.data) {
          acc.push(buildSingleSegment(seg.data, seg.mode));
        }
        return acc;
      }, []);
    };
    exports2.fromString = function fromString(data, version) {
      const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
      const nodes = buildNodes(segs);
      const graph = buildGraph(nodes, version);
      const path = dijkstra.find_path(graph.map, "start", "end");
      const optimizedSegs = [];
      for (let i = 1; i < path.length - 1; i++) {
        optimizedSegs.push(graph.table[path[i]].node);
      }
      return exports2.fromArray(mergeSegments(optimizedSegs));
    };
    exports2.rawSplit = function rawSplit(data) {
      return exports2.fromArray(
        getSegmentsFromString(data, Utils.isKanjiModeEnabled())
      );
    };
  }
});

// node_modules/qrcode/lib/core/qrcode.js
var require_qrcode = __commonJS({
  "node_modules/qrcode/lib/core/qrcode.js"(exports2) {
    var Utils = require_utils();
    var ECLevel = require_error_correction_level();
    var BitBuffer = require_bit_buffer();
    var BitMatrix = require_bit_matrix();
    var AlignmentPattern = require_alignment_pattern();
    var FinderPattern = require_finder_pattern();
    var MaskPattern = require_mask_pattern();
    var ECCode = require_error_correction_code();
    var ReedSolomonEncoder = require_reed_solomon_encoder();
    var Version = require_version();
    var FormatInfo = require_format_info();
    var Mode = require_mode();
    var Segments = require_segments();
    function setupFinderPattern(matrix, version) {
      const size = matrix.size;
      const pos = FinderPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -1; r <= 7; r++) {
          if (row + r <= -1 || size <= row + r) continue;
          for (let c = -1; c <= 7; c++) {
            if (col + c <= -1 || size <= col + c) continue;
            if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupTimingPattern(matrix) {
      const size = matrix.size;
      for (let r = 8; r < size - 8; r++) {
        const value = r % 2 === 0;
        matrix.set(r, 6, value, true);
        matrix.set(6, r, value, true);
      }
    }
    function setupAlignmentPattern(matrix, version) {
      const pos = AlignmentPattern.getPositions(version);
      for (let i = 0; i < pos.length; i++) {
        const row = pos[i][0];
        const col = pos[i][1];
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) {
              matrix.set(row + r, col + c, true, true);
            } else {
              matrix.set(row + r, col + c, false, true);
            }
          }
        }
      }
    }
    function setupVersionInfo(matrix, version) {
      const size = matrix.size;
      const bits = Version.getEncodedBits(version);
      let row, col, mod;
      for (let i = 0; i < 18; i++) {
        row = Math.floor(i / 3);
        col = i % 3 + size - 8 - 3;
        mod = (bits >> i & 1) === 1;
        matrix.set(row, col, mod, true);
        matrix.set(col, row, mod, true);
      }
    }
    function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
      const size = matrix.size;
      const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
      let i, mod;
      for (i = 0; i < 15; i++) {
        mod = (bits >> i & 1) === 1;
        if (i < 6) {
          matrix.set(i, 8, mod, true);
        } else if (i < 8) {
          matrix.set(i + 1, 8, mod, true);
        } else {
          matrix.set(size - 15 + i, 8, mod, true);
        }
        if (i < 8) {
          matrix.set(8, size - i - 1, mod, true);
        } else if (i < 9) {
          matrix.set(8, 15 - i - 1 + 1, mod, true);
        } else {
          matrix.set(8, 15 - i - 1, mod, true);
        }
      }
      matrix.set(size - 8, 8, 1, true);
    }
    function setupData(matrix, data) {
      const size = matrix.size;
      let inc = -1;
      let row = size - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (let c = 0; c < 2; c++) {
            if (!matrix.isReserved(row, col - c)) {
              let dark = false;
              if (byteIndex < data.length) {
                dark = (data[byteIndex] >>> bitIndex & 1) === 1;
              }
              matrix.set(row, col - c, dark);
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || size <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
    function createData(version, errorCorrectionLevel, segments) {
      const buffer = new BitBuffer();
      segments.forEach(function(data) {
        buffer.put(data.mode.bit, 4);
        buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
        data.write(buffer);
      });
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
        buffer.put(0, 4);
      }
      while (buffer.getLengthInBits() % 8 !== 0) {
        buffer.putBit(0);
      }
      const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
      for (let i = 0; i < remainingByte; i++) {
        buffer.put(i % 2 ? 17 : 236, 8);
      }
      return createCodewords(buffer, version, errorCorrectionLevel);
    }
    function createCodewords(bitBuffer, version, errorCorrectionLevel) {
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewords = totalCodewords - ecTotalCodewords;
      const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
      const blocksInGroup2 = totalCodewords % ecTotalBlocks;
      const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
      const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
      const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
      const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
      const rs = new ReedSolomonEncoder(ecCount);
      let offset = 0;
      const dcData = new Array(ecTotalBlocks);
      const ecData = new Array(ecTotalBlocks);
      let maxDataSize = 0;
      const buffer = new Uint8Array(bitBuffer.buffer);
      for (let b = 0; b < ecTotalBlocks; b++) {
        const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
        dcData[b] = buffer.slice(offset, offset + dataSize);
        ecData[b] = rs.encode(dcData[b]);
        offset += dataSize;
        maxDataSize = Math.max(maxDataSize, dataSize);
      }
      const data = new Uint8Array(totalCodewords);
      let index = 0;
      let i, r;
      for (i = 0; i < maxDataSize; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          if (i < dcData[r].length) {
            data[index++] = dcData[r][i];
          }
        }
      }
      for (i = 0; i < ecCount; i++) {
        for (r = 0; r < ecTotalBlocks; r++) {
          data[index++] = ecData[r][i];
        }
      }
      return data;
    }
    function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
      let segments;
      if (Array.isArray(data)) {
        segments = Segments.fromArray(data);
      } else if (typeof data === "string") {
        let estimatedVersion = version;
        if (!estimatedVersion) {
          const rawSegments = Segments.rawSplit(data);
          estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
        }
        segments = Segments.fromString(data, estimatedVersion || 40);
      } else {
        throw new Error("Invalid data");
      }
      const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
      if (!bestVersion) {
        throw new Error("The amount of data is too big to be stored in a QR Code");
      }
      if (!version) {
        version = bestVersion;
      } else if (version < bestVersion) {
        throw new Error(
          "\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n"
        );
      }
      const dataBits = createData(version, errorCorrectionLevel, segments);
      const moduleCount = Utils.getSymbolSize(version);
      const modules2 = new BitMatrix(moduleCount);
      setupFinderPattern(modules2, version);
      setupTimingPattern(modules2);
      setupAlignmentPattern(modules2, version);
      setupFormatInfo(modules2, errorCorrectionLevel, 0);
      if (version >= 7) {
        setupVersionInfo(modules2, version);
      }
      setupData(modules2, dataBits);
      if (isNaN(maskPattern)) {
        maskPattern = MaskPattern.getBestMask(
          modules2,
          setupFormatInfo.bind(null, modules2, errorCorrectionLevel)
        );
      }
      MaskPattern.applyMask(maskPattern, modules2);
      setupFormatInfo(modules2, errorCorrectionLevel, maskPattern);
      return {
        modules: modules2,
        version,
        errorCorrectionLevel,
        maskPattern,
        segments
      };
    }
    exports2.create = function create(data, options) {
      if (typeof data === "undefined" || data === "") {
        throw new Error("No input text");
      }
      let errorCorrectionLevel = ECLevel.M;
      let version;
      let mask;
      if (typeof options !== "undefined") {
        errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
        version = Version.from(options.version);
        mask = MaskPattern.from(options.maskPattern);
        if (options.toSJISFunc) {
          Utils.setToSJISFunction(options.toSJISFunc);
        }
      }
      return createSymbol(data, version, errorCorrectionLevel, mask);
    };
  }
});

// node_modules/pngjs/lib/chunkstream.js
var require_chunkstream = __commonJS({
  "node_modules/pngjs/lib/chunkstream.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var ChunkStream = module2.exports = function() {
      Stream.call(this);
      this._buffers = [];
      this._buffered = 0;
      this._reads = [];
      this._paused = false;
      this._encoding = "utf8";
      this.writable = true;
    };
    util.inherits(ChunkStream, Stream);
    ChunkStream.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
      process.nextTick(
        function() {
          this._process();
          if (this._paused && this._reads && this._reads.length > 0) {
            this._paused = false;
            this.emit("drain");
          }
        }.bind(this)
      );
    };
    ChunkStream.prototype.write = function(data, encoding) {
      if (!this.writable) {
        this.emit("error", new Error("Stream not writable"));
        return false;
      }
      let dataBuffer;
      if (Buffer.isBuffer(data)) {
        dataBuffer = data;
      } else {
        dataBuffer = Buffer.from(data, encoding || this._encoding);
      }
      this._buffers.push(dataBuffer);
      this._buffered += dataBuffer.length;
      this._process();
      if (this._reads && this._reads.length === 0) {
        this._paused = true;
      }
      return this.writable && !this._paused;
    };
    ChunkStream.prototype.end = function(data, encoding) {
      if (data) {
        this.write(data, encoding);
      }
      this.writable = false;
      if (!this._buffers) {
        return;
      }
      if (this._buffers.length === 0) {
        this._end();
      } else {
        this._buffers.push(null);
        this._process();
      }
    };
    ChunkStream.prototype.destroySoon = ChunkStream.prototype.end;
    ChunkStream.prototype._end = function() {
      if (this._reads.length > 0) {
        this.emit("error", new Error("Unexpected end of input"));
      }
      this.destroy();
    };
    ChunkStream.prototype.destroy = function() {
      if (!this._buffers) {
        return;
      }
      this.writable = false;
      this._reads = null;
      this._buffers = null;
      this.emit("close");
    };
    ChunkStream.prototype._processReadAllowingLess = function(read) {
      this._reads.shift();
      let smallerBuf = this._buffers[0];
      if (smallerBuf.length > read.length) {
        this._buffered -= read.length;
        this._buffers[0] = smallerBuf.slice(read.length);
        read.func.call(this, smallerBuf.slice(0, read.length));
      } else {
        this._buffered -= smallerBuf.length;
        this._buffers.shift();
        read.func.call(this, smallerBuf);
      }
    };
    ChunkStream.prototype._processRead = function(read) {
      this._reads.shift();
      let pos = 0;
      let count = 0;
      let data = Buffer.alloc(read.length);
      while (pos < read.length) {
        let buf = this._buffers[count++];
        let len = Math.min(buf.length, read.length - pos);
        buf.copy(data, pos, 0, len);
        pos += len;
        if (len !== buf.length) {
          this._buffers[--count] = buf.slice(len);
        }
      }
      if (count > 0) {
        this._buffers.splice(0, count);
      }
      this._buffered -= read.length;
      read.func.call(this, data);
    };
    ChunkStream.prototype._process = function() {
      try {
        while (this._buffered > 0 && this._reads && this._reads.length > 0) {
          let read = this._reads[0];
          if (read.allowLess) {
            this._processReadAllowingLess(read);
          } else if (this._buffered >= read.length) {
            this._processRead(read);
          } else {
            break;
          }
        }
        if (this._buffers && !this.writable) {
          this._end();
        }
      } catch (ex) {
        this.emit("error", ex);
      }
    };
  }
});

// node_modules/pngjs/lib/interlace.js
var require_interlace = __commonJS({
  "node_modules/pngjs/lib/interlace.js"(exports2) {
    "use strict";
    var imagePasses = [
      {
        // pass 1 - 1px
        x: [0],
        y: [0]
      },
      {
        // pass 2 - 1px
        x: [4],
        y: [0]
      },
      {
        // pass 3 - 2px
        x: [0, 4],
        y: [4]
      },
      {
        // pass 4 - 4px
        x: [2, 6],
        y: [0, 4]
      },
      {
        // pass 5 - 8px
        x: [0, 2, 4, 6],
        y: [2, 6]
      },
      {
        // pass 6 - 16px
        x: [1, 3, 5, 7],
        y: [0, 2, 4, 6]
      },
      {
        // pass 7 - 32px
        x: [0, 1, 2, 3, 4, 5, 6, 7],
        y: [1, 3, 5, 7]
      }
    ];
    exports2.getImagePasses = function(width, height) {
      let images = [];
      let xLeftOver = width % 8;
      let yLeftOver = height % 8;
      let xRepeats = (width - xLeftOver) / 8;
      let yRepeats = (height - yLeftOver) / 8;
      for (let i = 0; i < imagePasses.length; i++) {
        let pass = imagePasses[i];
        let passWidth = xRepeats * pass.x.length;
        let passHeight = yRepeats * pass.y.length;
        for (let j = 0; j < pass.x.length; j++) {
          if (pass.x[j] < xLeftOver) {
            passWidth++;
          } else {
            break;
          }
        }
        for (let j = 0; j < pass.y.length; j++) {
          if (pass.y[j] < yLeftOver) {
            passHeight++;
          } else {
            break;
          }
        }
        if (passWidth > 0 && passHeight > 0) {
          images.push({ width: passWidth, height: passHeight, index: i });
        }
      }
      return images;
    };
    exports2.getInterlaceIterator = function(width) {
      return function(x, y, pass) {
        let outerXLeftOver = x % imagePasses[pass].x.length;
        let outerX = (x - outerXLeftOver) / imagePasses[pass].x.length * 8 + imagePasses[pass].x[outerXLeftOver];
        let outerYLeftOver = y % imagePasses[pass].y.length;
        let outerY = (y - outerYLeftOver) / imagePasses[pass].y.length * 8 + imagePasses[pass].y[outerYLeftOver];
        return outerX * 4 + outerY * width * 4;
      };
    };
  }
});

// node_modules/pngjs/lib/paeth-predictor.js
var require_paeth_predictor = __commonJS({
  "node_modules/pngjs/lib/paeth-predictor.js"(exports2, module2) {
    "use strict";
    module2.exports = function paethPredictor(left, above, upLeft) {
      let paeth = left + above - upLeft;
      let pLeft = Math.abs(paeth - left);
      let pAbove = Math.abs(paeth - above);
      let pUpLeft = Math.abs(paeth - upLeft);
      if (pLeft <= pAbove && pLeft <= pUpLeft) {
        return left;
      }
      if (pAbove <= pUpLeft) {
        return above;
      }
      return upLeft;
    };
  }
});

// node_modules/pngjs/lib/filter-parse.js
var require_filter_parse = __commonJS({
  "node_modules/pngjs/lib/filter-parse.js"(exports2, module2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var paethPredictor = require_paeth_predictor();
    function getByteWidth(width, bpp, depth) {
      let byteWidth = width * bpp;
      if (depth !== 8) {
        byteWidth = Math.ceil(byteWidth / (8 / depth));
      }
      return byteWidth;
    }
    var Filter = module2.exports = function(bitmapInfo, dependencies) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let interlace = bitmapInfo.interlace;
      let bpp = bitmapInfo.bpp;
      let depth = bitmapInfo.depth;
      this.read = dependencies.read;
      this.write = dependencies.write;
      this.complete = dependencies.complete;
      this._imageIndex = 0;
      this._images = [];
      if (interlace) {
        let passes = interlaceUtils.getImagePasses(width, height);
        for (let i = 0; i < passes.length; i++) {
          this._images.push({
            byteWidth: getByteWidth(passes[i].width, bpp, depth),
            height: passes[i].height,
            lineIndex: 0
          });
        }
      } else {
        this._images.push({
          byteWidth: getByteWidth(width, bpp, depth),
          height,
          lineIndex: 0
        });
      }
      if (depth === 8) {
        this._xComparison = bpp;
      } else if (depth === 16) {
        this._xComparison = bpp * 2;
      } else {
        this._xComparison = 1;
      }
    };
    Filter.prototype.start = function() {
      this.read(
        this._images[this._imageIndex].byteWidth + 1,
        this._reverseFilterLine.bind(this)
      );
    };
    Filter.prototype._unFilterType1 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f1Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        unfilteredLine[x] = rawByte + f1Left;
      }
    };
    Filter.prototype._unFilterType2 = function(rawData, unfilteredLine, byteWidth) {
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f2Up = lastLine ? lastLine[x] : 0;
        unfilteredLine[x] = rawByte + f2Up;
      }
    };
    Filter.prototype._unFilterType3 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f3Up = lastLine ? lastLine[x] : 0;
        let f3Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f3Add = Math.floor((f3Left + f3Up) / 2);
        unfilteredLine[x] = rawByte + f3Add;
      }
    };
    Filter.prototype._unFilterType4 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f4Up = lastLine ? lastLine[x] : 0;
        let f4Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f4UpLeft = x > xBiggerThan && lastLine ? lastLine[x - xComparison] : 0;
        let f4Add = paethPredictor(f4Left, f4Up, f4UpLeft);
        unfilteredLine[x] = rawByte + f4Add;
      }
    };
    Filter.prototype._reverseFilterLine = function(rawData) {
      let filter = rawData[0];
      let unfilteredLine;
      let currentImage = this._images[this._imageIndex];
      let byteWidth = currentImage.byteWidth;
      if (filter === 0) {
        unfilteredLine = rawData.slice(1, byteWidth + 1);
      } else {
        unfilteredLine = Buffer.alloc(byteWidth);
        switch (filter) {
          case 1:
            this._unFilterType1(rawData, unfilteredLine, byteWidth);
            break;
          case 2:
            this._unFilterType2(rawData, unfilteredLine, byteWidth);
            break;
          case 3:
            this._unFilterType3(rawData, unfilteredLine, byteWidth);
            break;
          case 4:
            this._unFilterType4(rawData, unfilteredLine, byteWidth);
            break;
          default:
            throw new Error("Unrecognised filter type - " + filter);
        }
      }
      this.write(unfilteredLine);
      currentImage.lineIndex++;
      if (currentImage.lineIndex >= currentImage.height) {
        this._lastLine = null;
        this._imageIndex++;
        currentImage = this._images[this._imageIndex];
      } else {
        this._lastLine = unfilteredLine;
      }
      if (currentImage) {
        this.read(currentImage.byteWidth + 1, this._reverseFilterLine.bind(this));
      } else {
        this._lastLine = null;
        this.complete();
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-async.js
var require_filter_parse_async = __commonJS({
  "node_modules/pngjs/lib/filter-parse-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var ChunkStream = require_chunkstream();
    var Filter = require_filter_parse();
    var FilterAsync = module2.exports = function(bitmapInfo) {
      ChunkStream.call(this);
      let buffers = [];
      let that = this;
      this._filter = new Filter(bitmapInfo, {
        read: this.read.bind(this),
        write: function(buffer) {
          buffers.push(buffer);
        },
        complete: function() {
          that.emit("complete", Buffer.concat(buffers));
        }
      });
      this._filter.start();
    };
    util.inherits(FilterAsync, ChunkStream);
  }
});

// node_modules/pngjs/lib/constants.js
var require_constants = __commonJS({
  "node_modules/pngjs/lib/constants.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      PNG_SIGNATURE: [137, 80, 78, 71, 13, 10, 26, 10],
      TYPE_IHDR: 1229472850,
      TYPE_IEND: 1229278788,
      TYPE_IDAT: 1229209940,
      TYPE_PLTE: 1347179589,
      TYPE_tRNS: 1951551059,
      // eslint-disable-line camelcase
      TYPE_gAMA: 1732332865,
      // eslint-disable-line camelcase
      // color-type bits
      COLORTYPE_GRAYSCALE: 0,
      COLORTYPE_PALETTE: 1,
      COLORTYPE_COLOR: 2,
      COLORTYPE_ALPHA: 4,
      // e.g. grayscale and alpha
      // color-type combinations
      COLORTYPE_PALETTE_COLOR: 3,
      COLORTYPE_COLOR_ALPHA: 6,
      COLORTYPE_TO_BPP_MAP: {
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4
      },
      GAMMA_DIVISION: 1e5
    };
  }
});

// node_modules/pngjs/lib/crc.js
var require_crc = __commonJS({
  "node_modules/pngjs/lib/crc.js"(exports2, module2) {
    "use strict";
    var crcTable = [];
    (function() {
      for (let i = 0; i < 256; i++) {
        let currentCrc = i;
        for (let j = 0; j < 8; j++) {
          if (currentCrc & 1) {
            currentCrc = 3988292384 ^ currentCrc >>> 1;
          } else {
            currentCrc = currentCrc >>> 1;
          }
        }
        crcTable[i] = currentCrc;
      }
    })();
    var CrcCalculator = module2.exports = function() {
      this._crc = -1;
    };
    CrcCalculator.prototype.write = function(data) {
      for (let i = 0; i < data.length; i++) {
        this._crc = crcTable[(this._crc ^ data[i]) & 255] ^ this._crc >>> 8;
      }
      return true;
    };
    CrcCalculator.prototype.crc32 = function() {
      return this._crc ^ -1;
    };
    CrcCalculator.crc32 = function(buf) {
      let crc = -1;
      for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 255] ^ crc >>> 8;
      }
      return crc ^ -1;
    };
  }
});

// node_modules/pngjs/lib/parser.js
var require_parser = __commonJS({
  "node_modules/pngjs/lib/parser.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    var CrcCalculator = require_crc();
    var Parser = module2.exports = function(options, dependencies) {
      this._options = options;
      options.checkCRC = options.checkCRC !== false;
      this._hasIHDR = false;
      this._hasIEND = false;
      this._emittedHeadersFinished = false;
      this._palette = [];
      this._colorType = 0;
      this._chunks = {};
      this._chunks[constants.TYPE_IHDR] = this._handleIHDR.bind(this);
      this._chunks[constants.TYPE_IEND] = this._handleIEND.bind(this);
      this._chunks[constants.TYPE_IDAT] = this._handleIDAT.bind(this);
      this._chunks[constants.TYPE_PLTE] = this._handlePLTE.bind(this);
      this._chunks[constants.TYPE_tRNS] = this._handleTRNS.bind(this);
      this._chunks[constants.TYPE_gAMA] = this._handleGAMA.bind(this);
      this.read = dependencies.read;
      this.error = dependencies.error;
      this.metadata = dependencies.metadata;
      this.gamma = dependencies.gamma;
      this.transColor = dependencies.transColor;
      this.palette = dependencies.palette;
      this.parsed = dependencies.parsed;
      this.inflateData = dependencies.inflateData;
      this.finished = dependencies.finished;
      this.simpleTransparency = dependencies.simpleTransparency;
      this.headersFinished = dependencies.headersFinished || function() {
      };
    };
    Parser.prototype.start = function() {
      this.read(constants.PNG_SIGNATURE.length, this._parseSignature.bind(this));
    };
    Parser.prototype._parseSignature = function(data) {
      let signature = constants.PNG_SIGNATURE;
      for (let i = 0; i < signature.length; i++) {
        if (data[i] !== signature[i]) {
          this.error(new Error("Invalid file signature"));
          return;
        }
      }
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._parseChunkBegin = function(data) {
      let length = data.readUInt32BE(0);
      let type = data.readUInt32BE(4);
      let name = "";
      for (let i = 4; i < 8; i++) {
        name += String.fromCharCode(data[i]);
      }
      let ancillary = Boolean(data[4] & 32);
      if (!this._hasIHDR && type !== constants.TYPE_IHDR) {
        this.error(new Error("Expected IHDR on beggining"));
        return;
      }
      this._crc = new CrcCalculator();
      this._crc.write(Buffer.from(name));
      if (this._chunks[type]) {
        return this._chunks[type](length);
      }
      if (!ancillary) {
        this.error(new Error("Unsupported critical chunk type " + name));
        return;
      }
      this.read(length + 4, this._skipChunk.bind(this));
    };
    Parser.prototype._skipChunk = function() {
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._handleChunkEnd = function() {
      this.read(4, this._parseChunkEnd.bind(this));
    };
    Parser.prototype._parseChunkEnd = function(data) {
      let fileCrc = data.readInt32BE(0);
      let calcCrc = this._crc.crc32();
      if (this._options.checkCRC && calcCrc !== fileCrc) {
        this.error(new Error("Crc error - " + fileCrc + " - " + calcCrc));
        return;
      }
      if (!this._hasIEND) {
        this.read(8, this._parseChunkBegin.bind(this));
      }
    };
    Parser.prototype._handleIHDR = function(length) {
      this.read(length, this._parseIHDR.bind(this));
    };
    Parser.prototype._parseIHDR = function(data) {
      this._crc.write(data);
      let width = data.readUInt32BE(0);
      let height = data.readUInt32BE(4);
      let depth = data[8];
      let colorType = data[9];
      let compr = data[10];
      let filter = data[11];
      let interlace = data[12];
      if (depth !== 8 && depth !== 4 && depth !== 2 && depth !== 1 && depth !== 16) {
        this.error(new Error("Unsupported bit depth " + depth));
        return;
      }
      if (!(colorType in constants.COLORTYPE_TO_BPP_MAP)) {
        this.error(new Error("Unsupported color type"));
        return;
      }
      if (compr !== 0) {
        this.error(new Error("Unsupported compression method"));
        return;
      }
      if (filter !== 0) {
        this.error(new Error("Unsupported filter method"));
        return;
      }
      if (interlace !== 0 && interlace !== 1) {
        this.error(new Error("Unsupported interlace method"));
        return;
      }
      this._colorType = colorType;
      let bpp = constants.COLORTYPE_TO_BPP_MAP[this._colorType];
      this._hasIHDR = true;
      this.metadata({
        width,
        height,
        depth,
        interlace: Boolean(interlace),
        palette: Boolean(colorType & constants.COLORTYPE_PALETTE),
        color: Boolean(colorType & constants.COLORTYPE_COLOR),
        alpha: Boolean(colorType & constants.COLORTYPE_ALPHA),
        bpp,
        colorType
      });
      this._handleChunkEnd();
    };
    Parser.prototype._handlePLTE = function(length) {
      this.read(length, this._parsePLTE.bind(this));
    };
    Parser.prototype._parsePLTE = function(data) {
      this._crc.write(data);
      let entries = Math.floor(data.length / 3);
      for (let i = 0; i < entries; i++) {
        this._palette.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255]);
      }
      this.palette(this._palette);
      this._handleChunkEnd();
    };
    Parser.prototype._handleTRNS = function(length) {
      this.simpleTransparency();
      this.read(length, this._parseTRNS.bind(this));
    };
    Parser.prototype._parseTRNS = function(data) {
      this._crc.write(data);
      if (this._colorType === constants.COLORTYPE_PALETTE_COLOR) {
        if (this._palette.length === 0) {
          this.error(new Error("Transparency chunk must be after palette"));
          return;
        }
        if (data.length > this._palette.length) {
          this.error(new Error("More transparent colors than palette size"));
          return;
        }
        for (let i = 0; i < data.length; i++) {
          this._palette[i][3] = data[i];
        }
        this.palette(this._palette);
      }
      if (this._colorType === constants.COLORTYPE_GRAYSCALE) {
        this.transColor([data.readUInt16BE(0)]);
      }
      if (this._colorType === constants.COLORTYPE_COLOR) {
        this.transColor([
          data.readUInt16BE(0),
          data.readUInt16BE(2),
          data.readUInt16BE(4)
        ]);
      }
      this._handleChunkEnd();
    };
    Parser.prototype._handleGAMA = function(length) {
      this.read(length, this._parseGAMA.bind(this));
    };
    Parser.prototype._parseGAMA = function(data) {
      this._crc.write(data);
      this.gamma(data.readUInt32BE(0) / constants.GAMMA_DIVISION);
      this._handleChunkEnd();
    };
    Parser.prototype._handleIDAT = function(length) {
      if (!this._emittedHeadersFinished) {
        this._emittedHeadersFinished = true;
        this.headersFinished();
      }
      this.read(-length, this._parseIDAT.bind(this, length));
    };
    Parser.prototype._parseIDAT = function(length, data) {
      this._crc.write(data);
      if (this._colorType === constants.COLORTYPE_PALETTE_COLOR && this._palette.length === 0) {
        throw new Error("Expected palette not found");
      }
      this.inflateData(data);
      let leftOverLength = length - data.length;
      if (leftOverLength > 0) {
        this._handleIDAT(leftOverLength);
      } else {
        this._handleChunkEnd();
      }
    };
    Parser.prototype._handleIEND = function(length) {
      this.read(length, this._parseIEND.bind(this));
    };
    Parser.prototype._parseIEND = function(data) {
      this._crc.write(data);
      this._hasIEND = true;
      this._handleChunkEnd();
      if (this.finished) {
        this.finished();
      }
    };
  }
});

// node_modules/pngjs/lib/bitmapper.js
var require_bitmapper = __commonJS({
  "node_modules/pngjs/lib/bitmapper.js"(exports2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var pixelBppMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos === data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = 255;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 1 >= data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = data[rawPos + 1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 2 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = 255;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 3 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = data[rawPos + 3];
      }
    ];
    var pixelBppCustomMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = maxBit;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, pixelData, pxPos) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = pixelData[1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = maxBit;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, pixelData, pxPos) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = pixelData[3];
      }
    ];
    function bitRetriever(data, depth) {
      let leftOver = [];
      let i = 0;
      function split() {
        if (i === data.length) {
          throw new Error("Ran out of data");
        }
        let byte = data[i];
        i++;
        let byte8, byte7, byte6, byte5, byte4, byte3, byte2, byte1;
        switch (depth) {
          default:
            throw new Error("unrecognised depth");
          case 16:
            byte2 = data[i];
            i++;
            leftOver.push((byte << 8) + byte2);
            break;
          case 4:
            byte2 = byte & 15;
            byte1 = byte >> 4;
            leftOver.push(byte1, byte2);
            break;
          case 2:
            byte4 = byte & 3;
            byte3 = byte >> 2 & 3;
            byte2 = byte >> 4 & 3;
            byte1 = byte >> 6 & 3;
            leftOver.push(byte1, byte2, byte3, byte4);
            break;
          case 1:
            byte8 = byte & 1;
            byte7 = byte >> 1 & 1;
            byte6 = byte >> 2 & 1;
            byte5 = byte >> 3 & 1;
            byte4 = byte >> 4 & 1;
            byte3 = byte >> 5 & 1;
            byte2 = byte >> 6 & 1;
            byte1 = byte >> 7 & 1;
            leftOver.push(byte1, byte2, byte3, byte4, byte5, byte6, byte7, byte8);
            break;
        }
      }
      return {
        get: function(count) {
          while (leftOver.length < count) {
            split();
          }
          let returner = leftOver.slice(0, count);
          leftOver = leftOver.slice(count);
          return returner;
        },
        resetAfterLine: function() {
          leftOver.length = 0;
        },
        end: function() {
          if (i !== data.length) {
            throw new Error("extra data found");
          }
        }
      };
    }
    function mapImage8Bit(image, pxData, getPxPos, bpp, data, rawPos) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppMapper[bpp](pxData, data, pxPos, rawPos);
          rawPos += bpp;
        }
      }
      return rawPos;
    }
    function mapImageCustomBit(image, pxData, getPxPos, bpp, bits, maxBit) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pixelData = bits.get(bpp);
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppCustomMapper[bpp](pxData, pixelData, pxPos, maxBit);
        }
        bits.resetAfterLine();
      }
    }
    exports2.dataToBitMap = function(data, bitmapInfo) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let depth = bitmapInfo.depth;
      let bpp = bitmapInfo.bpp;
      let interlace = bitmapInfo.interlace;
      let bits;
      if (depth !== 8) {
        bits = bitRetriever(data, depth);
      }
      let pxData;
      if (depth <= 8) {
        pxData = Buffer.alloc(width * height * 4);
      } else {
        pxData = new Uint16Array(width * height * 4);
      }
      let maxBit = Math.pow(2, depth) - 1;
      let rawPos = 0;
      let images;
      let getPxPos;
      if (interlace) {
        images = interlaceUtils.getImagePasses(width, height);
        getPxPos = interlaceUtils.getInterlaceIterator(width, height);
      } else {
        let nonInterlacedPxPos = 0;
        getPxPos = function() {
          let returner = nonInterlacedPxPos;
          nonInterlacedPxPos += 4;
          return returner;
        };
        images = [{ width, height }];
      }
      for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
        if (depth === 8) {
          rawPos = mapImage8Bit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            data,
            rawPos
          );
        } else {
          mapImageCustomBit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            bits,
            maxBit
          );
        }
      }
      if (depth === 8) {
        if (rawPos !== data.length) {
          throw new Error("extra data found");
        }
      } else {
        bits.end();
      }
      return pxData;
    };
  }
});

// node_modules/pngjs/lib/format-normaliser.js
var require_format_normaliser = __commonJS({
  "node_modules/pngjs/lib/format-normaliser.js"(exports2, module2) {
    "use strict";
    function dePalette(indata, outdata, width, height, palette) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let color = palette[indata[pxPos]];
          if (!color) {
            throw new Error("index " + indata[pxPos] + " not in palette");
          }
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = color[i];
          }
          pxPos += 4;
        }
      }
    }
    function replaceTransparentColor(indata, outdata, width, height, transColor) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let makeTrans = false;
          if (transColor.length === 1) {
            if (transColor[0] === indata[pxPos]) {
              makeTrans = true;
            }
          } else if (transColor[0] === indata[pxPos] && transColor[1] === indata[pxPos + 1] && transColor[2] === indata[pxPos + 2]) {
            makeTrans = true;
          }
          if (makeTrans) {
            for (let i = 0; i < 4; i++) {
              outdata[pxPos + i] = 0;
            }
          }
          pxPos += 4;
        }
      }
    }
    function scaleDepth(indata, outdata, width, height, depth) {
      let maxOutSample = 255;
      let maxInSample = Math.pow(2, depth) - 1;
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = Math.floor(
              indata[pxPos + i] * maxOutSample / maxInSample + 0.5
            );
          }
          pxPos += 4;
        }
      }
    }
    module2.exports = function(indata, imageData) {
      let depth = imageData.depth;
      let width = imageData.width;
      let height = imageData.height;
      let colorType = imageData.colorType;
      let transColor = imageData.transColor;
      let palette = imageData.palette;
      let outdata = indata;
      if (colorType === 3) {
        dePalette(indata, outdata, width, height, palette);
      } else {
        if (transColor) {
          replaceTransparentColor(indata, outdata, width, height, transColor);
        }
        if (depth !== 8) {
          if (depth === 16) {
            outdata = Buffer.alloc(width * height * 4);
          }
          scaleDepth(indata, outdata, width, height, depth);
        }
      }
      return outdata;
    };
  }
});

// node_modules/pngjs/lib/parser-async.js
var require_parser_async = __commonJS({
  "node_modules/pngjs/lib/parser-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var zlib = require("zlib");
    var ChunkStream = require_chunkstream();
    var FilterAsync = require_filter_parse_async();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    var ParserAsync = module2.exports = function(options) {
      ChunkStream.call(this);
      this._parser = new Parser(options, {
        read: this.read.bind(this),
        error: this._handleError.bind(this),
        metadata: this._handleMetaData.bind(this),
        gamma: this.emit.bind(this, "gamma"),
        palette: this._handlePalette.bind(this),
        transColor: this._handleTransColor.bind(this),
        finished: this._finished.bind(this),
        inflateData: this._inflateData.bind(this),
        simpleTransparency: this._simpleTransparency.bind(this),
        headersFinished: this._headersFinished.bind(this)
      });
      this._options = options;
      this.writable = true;
      this._parser.start();
    };
    util.inherits(ParserAsync, ChunkStream);
    ParserAsync.prototype._handleError = function(err) {
      this.emit("error", err);
      this.writable = false;
      this.destroy();
      if (this._inflate && this._inflate.destroy) {
        this._inflate.destroy();
      }
      if (this._filter) {
        this._filter.destroy();
        this._filter.on("error", function() {
        });
      }
      this.errord = true;
    };
    ParserAsync.prototype._inflateData = function(data) {
      if (!this._inflate) {
        if (this._bitmapInfo.interlace) {
          this._inflate = zlib.createInflate();
          this._inflate.on("error", this.emit.bind(this, "error"));
          this._filter.on("complete", this._complete.bind(this));
          this._inflate.pipe(this._filter);
        } else {
          let rowSize = (this._bitmapInfo.width * this._bitmapInfo.bpp * this._bitmapInfo.depth + 7 >> 3) + 1;
          let imageSize = rowSize * this._bitmapInfo.height;
          let chunkSize = Math.max(imageSize, zlib.Z_MIN_CHUNK);
          this._inflate = zlib.createInflate({ chunkSize });
          let leftToInflate = imageSize;
          let emitError = this.emit.bind(this, "error");
          this._inflate.on("error", function(err) {
            if (!leftToInflate) {
              return;
            }
            emitError(err);
          });
          this._filter.on("complete", this._complete.bind(this));
          let filterWrite = this._filter.write.bind(this._filter);
          this._inflate.on("data", function(chunk) {
            if (!leftToInflate) {
              return;
            }
            if (chunk.length > leftToInflate) {
              chunk = chunk.slice(0, leftToInflate);
            }
            leftToInflate -= chunk.length;
            filterWrite(chunk);
          });
          this._inflate.on("end", this._filter.end.bind(this._filter));
        }
      }
      this._inflate.write(data);
    };
    ParserAsync.prototype._handleMetaData = function(metaData) {
      this._metaData = metaData;
      this._bitmapInfo = Object.create(metaData);
      this._filter = new FilterAsync(this._bitmapInfo);
    };
    ParserAsync.prototype._handleTransColor = function(transColor) {
      this._bitmapInfo.transColor = transColor;
    };
    ParserAsync.prototype._handlePalette = function(palette) {
      this._bitmapInfo.palette = palette;
    };
    ParserAsync.prototype._simpleTransparency = function() {
      this._metaData.alpha = true;
    };
    ParserAsync.prototype._headersFinished = function() {
      this.emit("metadata", this._metaData);
    };
    ParserAsync.prototype._finished = function() {
      if (this.errord) {
        return;
      }
      if (!this._inflate) {
        this.emit("error", "No Inflate block");
      } else {
        this._inflate.end();
      }
    };
    ParserAsync.prototype._complete = function(filteredData) {
      if (this.errord) {
        return;
      }
      let normalisedBitmapData;
      try {
        let bitmapData = bitmapper.dataToBitMap(filteredData, this._bitmapInfo);
        normalisedBitmapData = formatNormaliser(bitmapData, this._bitmapInfo);
        bitmapData = null;
      } catch (ex) {
        this._handleError(ex);
        return;
      }
      this.emit("parsed", normalisedBitmapData);
    };
  }
});

// node_modules/pngjs/lib/bitpacker.js
var require_bitpacker = __commonJS({
  "node_modules/pngjs/lib/bitpacker.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    module2.exports = function(dataIn, width, height, options) {
      let outHasAlpha = [constants.COLORTYPE_COLOR_ALPHA, constants.COLORTYPE_ALPHA].indexOf(
        options.colorType
      ) !== -1;
      if (options.colorType === options.inputColorType) {
        let bigEndian = (function() {
          let buffer = new ArrayBuffer(2);
          new DataView(buffer).setInt16(
            0,
            256,
            true
            /* littleEndian */
          );
          return new Int16Array(buffer)[0] !== 256;
        })();
        if (options.bitDepth === 8 || options.bitDepth === 16 && bigEndian) {
          return dataIn;
        }
      }
      let data = options.bitDepth !== 16 ? dataIn : new Uint16Array(dataIn.buffer);
      let maxValue = 255;
      let inBpp = constants.COLORTYPE_TO_BPP_MAP[options.inputColorType];
      if (inBpp === 4 && !options.inputHasAlpha) {
        inBpp = 3;
      }
      let outBpp = constants.COLORTYPE_TO_BPP_MAP[options.colorType];
      if (options.bitDepth === 16) {
        maxValue = 65535;
        outBpp *= 2;
      }
      let outData = Buffer.alloc(width * height * outBpp);
      let inIndex = 0;
      let outIndex = 0;
      let bgColor = options.bgColor || {};
      if (bgColor.red === void 0) {
        bgColor.red = maxValue;
      }
      if (bgColor.green === void 0) {
        bgColor.green = maxValue;
      }
      if (bgColor.blue === void 0) {
        bgColor.blue = maxValue;
      }
      function getRGBA() {
        let red;
        let green;
        let blue;
        let alpha = maxValue;
        switch (options.inputColorType) {
          case constants.COLORTYPE_COLOR_ALPHA:
            alpha = data[inIndex + 3];
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants.COLORTYPE_COLOR:
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants.COLORTYPE_ALPHA:
            alpha = data[inIndex + 1];
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          case constants.COLORTYPE_GRAYSCALE:
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          default:
            throw new Error(
              "input color type:" + options.inputColorType + " is not supported at present"
            );
        }
        if (options.inputHasAlpha) {
          if (!outHasAlpha) {
            alpha /= maxValue;
            red = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.red + alpha * red), 0),
              maxValue
            );
            green = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.green + alpha * green), 0),
              maxValue
            );
            blue = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.blue + alpha * blue), 0),
              maxValue
            );
          }
        }
        return { red, green, blue, alpha };
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let rgba = getRGBA(data, inIndex);
          switch (options.colorType) {
            case constants.COLORTYPE_COLOR_ALPHA:
            case constants.COLORTYPE_COLOR:
              if (options.bitDepth === 8) {
                outData[outIndex] = rgba.red;
                outData[outIndex + 1] = rgba.green;
                outData[outIndex + 2] = rgba.blue;
                if (outHasAlpha) {
                  outData[outIndex + 3] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(rgba.red, outIndex);
                outData.writeUInt16BE(rgba.green, outIndex + 2);
                outData.writeUInt16BE(rgba.blue, outIndex + 4);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 6);
                }
              }
              break;
            case constants.COLORTYPE_ALPHA:
            case constants.COLORTYPE_GRAYSCALE: {
              let grayscale = (rgba.red + rgba.green + rgba.blue) / 3;
              if (options.bitDepth === 8) {
                outData[outIndex] = grayscale;
                if (outHasAlpha) {
                  outData[outIndex + 1] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(grayscale, outIndex);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 2);
                }
              }
              break;
            }
            default:
              throw new Error("unrecognised color Type " + options.colorType);
          }
          inIndex += inBpp;
          outIndex += outBpp;
        }
      }
      return outData;
    };
  }
});

// node_modules/pngjs/lib/filter-pack.js
var require_filter_pack = __commonJS({
  "node_modules/pngjs/lib/filter-pack.js"(exports2, module2) {
    "use strict";
    var paethPredictor = require_paeth_predictor();
    function filterNone(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        rawData[rawPos + x] = pxData[pxPos + x];
      }
    }
    function filterSumNone(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let i = pxPos; i < length; i++) {
        sum += Math.abs(pxData[i]);
      }
      return sum;
    }
    function filterSub(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumSub(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterUp(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - up;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumUp(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let x = pxPos; x < length; x++) {
        let up = pxPos > 0 ? pxData[x - byteWidth] : 0;
        let val = pxData[x] - up;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterAvg(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumAvg(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterPaeth(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumPaeth(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        sum += Math.abs(val);
      }
      return sum;
    }
    var filters = {
      0: filterNone,
      1: filterSub,
      2: filterUp,
      3: filterAvg,
      4: filterPaeth
    };
    var filterSums = {
      0: filterSumNone,
      1: filterSumSub,
      2: filterSumUp,
      3: filterSumAvg,
      4: filterSumPaeth
    };
    module2.exports = function(pxData, width, height, options, bpp) {
      let filterTypes;
      if (!("filterType" in options) || options.filterType === -1) {
        filterTypes = [0, 1, 2, 3, 4];
      } else if (typeof options.filterType === "number") {
        filterTypes = [options.filterType];
      } else {
        throw new Error("unrecognised filter types");
      }
      if (options.bitDepth === 16) {
        bpp *= 2;
      }
      let byteWidth = width * bpp;
      let rawPos = 0;
      let pxPos = 0;
      let rawData = Buffer.alloc((byteWidth + 1) * height);
      let sel = filterTypes[0];
      for (let y = 0; y < height; y++) {
        if (filterTypes.length > 1) {
          let min = Infinity;
          for (let i = 0; i < filterTypes.length; i++) {
            let sum = filterSums[filterTypes[i]](pxData, pxPos, byteWidth, bpp);
            if (sum < min) {
              sel = filterTypes[i];
              min = sum;
            }
          }
        }
        rawData[rawPos] = sel;
        rawPos++;
        filters[sel](pxData, pxPos, byteWidth, rawData, rawPos, bpp);
        rawPos += byteWidth;
        pxPos += byteWidth;
      }
      return rawData;
    };
  }
});

// node_modules/pngjs/lib/packer.js
var require_packer = __commonJS({
  "node_modules/pngjs/lib/packer.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    var CrcStream = require_crc();
    var bitPacker = require_bitpacker();
    var filter = require_filter_pack();
    var zlib = require("zlib");
    var Packer = module2.exports = function(options) {
      this._options = options;
      options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
      options.deflateLevel = options.deflateLevel != null ? options.deflateLevel : 9;
      options.deflateStrategy = options.deflateStrategy != null ? options.deflateStrategy : 3;
      options.inputHasAlpha = options.inputHasAlpha != null ? options.inputHasAlpha : true;
      options.deflateFactory = options.deflateFactory || zlib.createDeflate;
      options.bitDepth = options.bitDepth || 8;
      options.colorType = typeof options.colorType === "number" ? options.colorType : constants.COLORTYPE_COLOR_ALPHA;
      options.inputColorType = typeof options.inputColorType === "number" ? options.inputColorType : constants.COLORTYPE_COLOR_ALPHA;
      if ([
        constants.COLORTYPE_GRAYSCALE,
        constants.COLORTYPE_COLOR,
        constants.COLORTYPE_COLOR_ALPHA,
        constants.COLORTYPE_ALPHA
      ].indexOf(options.colorType) === -1) {
        throw new Error(
          "option color type:" + options.colorType + " is not supported at present"
        );
      }
      if ([
        constants.COLORTYPE_GRAYSCALE,
        constants.COLORTYPE_COLOR,
        constants.COLORTYPE_COLOR_ALPHA,
        constants.COLORTYPE_ALPHA
      ].indexOf(options.inputColorType) === -1) {
        throw new Error(
          "option input color type:" + options.inputColorType + " is not supported at present"
        );
      }
      if (options.bitDepth !== 8 && options.bitDepth !== 16) {
        throw new Error(
          "option bit depth:" + options.bitDepth + " is not supported at present"
        );
      }
    };
    Packer.prototype.getDeflateOptions = function() {
      return {
        chunkSize: this._options.deflateChunkSize,
        level: this._options.deflateLevel,
        strategy: this._options.deflateStrategy
      };
    };
    Packer.prototype.createDeflate = function() {
      return this._options.deflateFactory(this.getDeflateOptions());
    };
    Packer.prototype.filterData = function(data, width, height) {
      let packedData = bitPacker(data, width, height, this._options);
      let bpp = constants.COLORTYPE_TO_BPP_MAP[this._options.colorType];
      let filteredData = filter(packedData, width, height, this._options, bpp);
      return filteredData;
    };
    Packer.prototype._packChunk = function(type, data) {
      let len = data ? data.length : 0;
      let buf = Buffer.alloc(len + 12);
      buf.writeUInt32BE(len, 0);
      buf.writeUInt32BE(type, 4);
      if (data) {
        data.copy(buf, 8);
      }
      buf.writeInt32BE(
        CrcStream.crc32(buf.slice(4, buf.length - 4)),
        buf.length - 4
      );
      return buf;
    };
    Packer.prototype.packGAMA = function(gamma) {
      let buf = Buffer.alloc(4);
      buf.writeUInt32BE(Math.floor(gamma * constants.GAMMA_DIVISION), 0);
      return this._packChunk(constants.TYPE_gAMA, buf);
    };
    Packer.prototype.packIHDR = function(width, height) {
      let buf = Buffer.alloc(13);
      buf.writeUInt32BE(width, 0);
      buf.writeUInt32BE(height, 4);
      buf[8] = this._options.bitDepth;
      buf[9] = this._options.colorType;
      buf[10] = 0;
      buf[11] = 0;
      buf[12] = 0;
      return this._packChunk(constants.TYPE_IHDR, buf);
    };
    Packer.prototype.packIDAT = function(data) {
      return this._packChunk(constants.TYPE_IDAT, data);
    };
    Packer.prototype.packIEND = function() {
      return this._packChunk(constants.TYPE_IEND, null);
    };
  }
});

// node_modules/pngjs/lib/packer-async.js
var require_packer_async = __commonJS({
  "node_modules/pngjs/lib/packer-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var constants = require_constants();
    var Packer = require_packer();
    var PackerAsync = module2.exports = function(opt) {
      Stream.call(this);
      let options = opt || {};
      this._packer = new Packer(options);
      this._deflate = this._packer.createDeflate();
      this.readable = true;
    };
    util.inherits(PackerAsync, Stream);
    PackerAsync.prototype.pack = function(data, width, height, gamma) {
      this.emit("data", Buffer.from(constants.PNG_SIGNATURE));
      this.emit("data", this._packer.packIHDR(width, height));
      if (gamma) {
        this.emit("data", this._packer.packGAMA(gamma));
      }
      let filteredData = this._packer.filterData(data, width, height);
      this._deflate.on("error", this.emit.bind(this, "error"));
      this._deflate.on(
        "data",
        function(compressedData) {
          this.emit("data", this._packer.packIDAT(compressedData));
        }.bind(this)
      );
      this._deflate.on(
        "end",
        function() {
          this.emit("data", this._packer.packIEND());
          this.emit("end");
        }.bind(this)
      );
      this._deflate.end(filteredData);
    };
  }
});

// node_modules/pngjs/lib/sync-inflate.js
var require_sync_inflate = __commonJS({
  "node_modules/pngjs/lib/sync-inflate.js"(exports2, module2) {
    "use strict";
    var assert = require("assert").ok;
    var zlib = require("zlib");
    var util = require("util");
    var kMaxLength = require("buffer").kMaxLength;
    function Inflate(opts) {
      if (!(this instanceof Inflate)) {
        return new Inflate(opts);
      }
      if (opts && opts.chunkSize < zlib.Z_MIN_CHUNK) {
        opts.chunkSize = zlib.Z_MIN_CHUNK;
      }
      zlib.Inflate.call(this, opts);
      this._offset = this._offset === void 0 ? this._outOffset : this._offset;
      this._buffer = this._buffer || this._outBuffer;
      if (opts && opts.maxLength != null) {
        this._maxLength = opts.maxLength;
      }
    }
    function createInflate(opts) {
      return new Inflate(opts);
    }
    function _close(engine, callback) {
      if (callback) {
        process.nextTick(callback);
      }
      if (!engine._handle) {
        return;
      }
      engine._handle.close();
      engine._handle = null;
    }
    Inflate.prototype._processChunk = function(chunk, flushFlag, asyncCb) {
      if (typeof asyncCb === "function") {
        return zlib.Inflate._processChunk.call(this, chunk, flushFlag, asyncCb);
      }
      let self = this;
      let availInBefore = chunk && chunk.length;
      let availOutBefore = this._chunkSize - this._offset;
      let leftToInflate = this._maxLength;
      let inOff = 0;
      let buffers = [];
      let nread = 0;
      let error;
      this.on("error", function(err) {
        error = err;
      });
      function handleChunk(availInAfter, availOutAfter) {
        if (self._hadError) {
          return;
        }
        let have = availOutBefore - availOutAfter;
        assert(have >= 0, "have should not go down");
        if (have > 0) {
          let out = self._buffer.slice(self._offset, self._offset + have);
          self._offset += have;
          if (out.length > leftToInflate) {
            out = out.slice(0, leftToInflate);
          }
          buffers.push(out);
          nread += out.length;
          leftToInflate -= out.length;
          if (leftToInflate === 0) {
            return false;
          }
        }
        if (availOutAfter === 0 || self._offset >= self._chunkSize) {
          availOutBefore = self._chunkSize;
          self._offset = 0;
          self._buffer = Buffer.allocUnsafe(self._chunkSize);
        }
        if (availOutAfter === 0) {
          inOff += availInBefore - availInAfter;
          availInBefore = availInAfter;
          return true;
        }
        return false;
      }
      assert(this._handle, "zlib binding closed");
      let res;
      do {
        res = this._handle.writeSync(
          flushFlag,
          chunk,
          // in
          inOff,
          // in_off
          availInBefore,
          // in_len
          this._buffer,
          // out
          this._offset,
          //out_off
          availOutBefore
        );
        res = res || this._writeState;
      } while (!this._hadError && handleChunk(res[0], res[1]));
      if (this._hadError) {
        throw error;
      }
      if (nread >= kMaxLength) {
        _close(this);
        throw new RangeError(
          "Cannot create final Buffer. It would be larger than 0x" + kMaxLength.toString(16) + " bytes"
        );
      }
      let buf = Buffer.concat(buffers, nread);
      _close(this);
      return buf;
    };
    util.inherits(Inflate, zlib.Inflate);
    function zlibBufferSync(engine, buffer) {
      if (typeof buffer === "string") {
        buffer = Buffer.from(buffer);
      }
      if (!(buffer instanceof Buffer)) {
        throw new TypeError("Not a string or buffer");
      }
      let flushFlag = engine._finishFlushFlag;
      if (flushFlag == null) {
        flushFlag = zlib.Z_FINISH;
      }
      return engine._processChunk(buffer, flushFlag);
    }
    function inflateSync(buffer, opts) {
      return zlibBufferSync(new Inflate(opts), buffer);
    }
    module2.exports = exports2 = inflateSync;
    exports2.Inflate = Inflate;
    exports2.createInflate = createInflate;
    exports2.inflateSync = inflateSync;
  }
});

// node_modules/pngjs/lib/sync-reader.js
var require_sync_reader = __commonJS({
  "node_modules/pngjs/lib/sync-reader.js"(exports2, module2) {
    "use strict";
    var SyncReader = module2.exports = function(buffer) {
      this._buffer = buffer;
      this._reads = [];
    };
    SyncReader.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
    };
    SyncReader.prototype.process = function() {
      while (this._reads.length > 0 && this._buffer.length) {
        let read = this._reads[0];
        if (this._buffer.length && (this._buffer.length >= read.length || read.allowLess)) {
          this._reads.shift();
          let buf = this._buffer;
          this._buffer = buf.slice(read.length);
          read.func.call(this, buf.slice(0, read.length));
        } else {
          break;
        }
      }
      if (this._reads.length > 0) {
        return new Error("There are some read requests waitng on finished stream");
      }
      if (this._buffer.length > 0) {
        return new Error("unrecognised content at end of stream");
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-sync.js
var require_filter_parse_sync = __commonJS({
  "node_modules/pngjs/lib/filter-parse-sync.js"(exports2) {
    "use strict";
    var SyncReader = require_sync_reader();
    var Filter = require_filter_parse();
    exports2.process = function(inBuffer, bitmapInfo) {
      let outBuffers = [];
      let reader = new SyncReader(inBuffer);
      let filter = new Filter(bitmapInfo, {
        read: reader.read.bind(reader),
        write: function(bufferPart) {
          outBuffers.push(bufferPart);
        },
        complete: function() {
        }
      });
      filter.start();
      reader.process();
      return Buffer.concat(outBuffers);
    };
  }
});

// node_modules/pngjs/lib/parser-sync.js
var require_parser_sync = __commonJS({
  "node_modules/pngjs/lib/parser-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    var inflateSync = require_sync_inflate();
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var SyncReader = require_sync_reader();
    var FilterSync = require_filter_parse_sync();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    module2.exports = function(buffer, options) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let err;
      function handleError(_err_) {
        err = _err_;
      }
      let metaData;
      function handleMetaData(_metaData_) {
        metaData = _metaData_;
      }
      function handleTransColor(transColor) {
        metaData.transColor = transColor;
      }
      function handlePalette(palette) {
        metaData.palette = palette;
      }
      function handleSimpleTransparency() {
        metaData.alpha = true;
      }
      let gamma;
      function handleGamma(_gamma_) {
        gamma = _gamma_;
      }
      let inflateDataList = [];
      function handleInflateData(inflatedData2) {
        inflateDataList.push(inflatedData2);
      }
      let reader = new SyncReader(buffer);
      let parser = new Parser(options, {
        read: reader.read.bind(reader),
        error: handleError,
        metadata: handleMetaData,
        gamma: handleGamma,
        palette: handlePalette,
        transColor: handleTransColor,
        inflateData: handleInflateData,
        simpleTransparency: handleSimpleTransparency
      });
      parser.start();
      reader.process();
      if (err) {
        throw err;
      }
      let inflateData = Buffer.concat(inflateDataList);
      inflateDataList.length = 0;
      let inflatedData;
      if (metaData.interlace) {
        inflatedData = zlib.inflateSync(inflateData);
      } else {
        let rowSize = (metaData.width * metaData.bpp * metaData.depth + 7 >> 3) + 1;
        let imageSize = rowSize * metaData.height;
        inflatedData = inflateSync(inflateData, {
          chunkSize: imageSize,
          maxLength: imageSize
        });
      }
      inflateData = null;
      if (!inflatedData || !inflatedData.length) {
        throw new Error("bad png - invalid inflate data response");
      }
      let unfilteredData = FilterSync.process(inflatedData, metaData);
      inflateData = null;
      let bitmapData = bitmapper.dataToBitMap(unfilteredData, metaData);
      unfilteredData = null;
      let normalisedBitmapData = formatNormaliser(bitmapData, metaData);
      metaData.data = normalisedBitmapData;
      metaData.gamma = gamma || 0;
      return metaData;
    };
  }
});

// node_modules/pngjs/lib/packer-sync.js
var require_packer_sync = __commonJS({
  "node_modules/pngjs/lib/packer-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var constants = require_constants();
    var Packer = require_packer();
    module2.exports = function(metaData, opt) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let options = opt || {};
      let packer = new Packer(options);
      let chunks = [];
      chunks.push(Buffer.from(constants.PNG_SIGNATURE));
      chunks.push(packer.packIHDR(metaData.width, metaData.height));
      if (metaData.gamma) {
        chunks.push(packer.packGAMA(metaData.gamma));
      }
      let filteredData = packer.filterData(
        metaData.data,
        metaData.width,
        metaData.height
      );
      let compressedData = zlib.deflateSync(
        filteredData,
        packer.getDeflateOptions()
      );
      filteredData = null;
      if (!compressedData || !compressedData.length) {
        throw new Error("bad png - invalid compressed data response");
      }
      chunks.push(packer.packIDAT(compressedData));
      chunks.push(packer.packIEND());
      return Buffer.concat(chunks);
    };
  }
});

// node_modules/pngjs/lib/png-sync.js
var require_png_sync = __commonJS({
  "node_modules/pngjs/lib/png-sync.js"(exports2) {
    "use strict";
    var parse = require_parser_sync();
    var pack = require_packer_sync();
    exports2.read = function(buffer, options) {
      return parse(buffer, options || {});
    };
    exports2.write = function(png, options) {
      return pack(png, options);
    };
  }
});

// node_modules/pngjs/lib/png.js
var require_png = __commonJS({
  "node_modules/pngjs/lib/png.js"(exports2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var Parser = require_parser_async();
    var Packer = require_packer_async();
    var PNGSync = require_png_sync();
    var PNG = exports2.PNG = function(options) {
      Stream.call(this);
      options = options || {};
      this.width = options.width | 0;
      this.height = options.height | 0;
      this.data = this.width > 0 && this.height > 0 ? Buffer.alloc(4 * this.width * this.height) : null;
      if (options.fill && this.data) {
        this.data.fill(0);
      }
      this.gamma = 0;
      this.readable = this.writable = true;
      this._parser = new Parser(options);
      this._parser.on("error", this.emit.bind(this, "error"));
      this._parser.on("close", this._handleClose.bind(this));
      this._parser.on("metadata", this._metadata.bind(this));
      this._parser.on("gamma", this._gamma.bind(this));
      this._parser.on(
        "parsed",
        function(data) {
          this.data = data;
          this.emit("parsed", data);
        }.bind(this)
      );
      this._packer = new Packer(options);
      this._packer.on("data", this.emit.bind(this, "data"));
      this._packer.on("end", this.emit.bind(this, "end"));
      this._parser.on("close", this._handleClose.bind(this));
      this._packer.on("error", this.emit.bind(this, "error"));
    };
    util.inherits(PNG, Stream);
    PNG.sync = PNGSync;
    PNG.prototype.pack = function() {
      if (!this.data || !this.data.length) {
        this.emit("error", "No data provided");
        return this;
      }
      process.nextTick(
        function() {
          this._packer.pack(this.data, this.width, this.height, this.gamma);
        }.bind(this)
      );
      return this;
    };
    PNG.prototype.parse = function(data, callback) {
      if (callback) {
        let onParsed, onError;
        onParsed = function(parsedData) {
          this.removeListener("error", onError);
          this.data = parsedData;
          callback(null, this);
        }.bind(this);
        onError = function(err) {
          this.removeListener("parsed", onParsed);
          callback(err, null);
        }.bind(this);
        this.once("parsed", onParsed);
        this.once("error", onError);
      }
      this.end(data);
      return this;
    };
    PNG.prototype.write = function(data) {
      this._parser.write(data);
      return true;
    };
    PNG.prototype.end = function(data) {
      this._parser.end(data);
    };
    PNG.prototype._metadata = function(metadata) {
      this.width = metadata.width;
      this.height = metadata.height;
      this.emit("metadata", metadata);
    };
    PNG.prototype._gamma = function(gamma) {
      this.gamma = gamma;
    };
    PNG.prototype._handleClose = function() {
      if (!this._parser.writable && !this._packer.readable) {
        this.emit("close");
      }
    };
    PNG.bitblt = function(src, dst, srcX, srcY, width, height, deltaX, deltaY) {
      srcX |= 0;
      srcY |= 0;
      width |= 0;
      height |= 0;
      deltaX |= 0;
      deltaY |= 0;
      if (srcX > src.width || srcY > src.height || srcX + width > src.width || srcY + height > src.height) {
        throw new Error("bitblt reading outside image");
      }
      if (deltaX > dst.width || deltaY > dst.height || deltaX + width > dst.width || deltaY + height > dst.height) {
        throw new Error("bitblt writing outside image");
      }
      for (let y = 0; y < height; y++) {
        src.data.copy(
          dst.data,
          (deltaY + y) * dst.width + deltaX << 2,
          (srcY + y) * src.width + srcX << 2,
          (srcY + y) * src.width + srcX + width << 2
        );
      }
    };
    PNG.prototype.bitblt = function(dst, srcX, srcY, width, height, deltaX, deltaY) {
      PNG.bitblt(this, dst, srcX, srcY, width, height, deltaX, deltaY);
      return this;
    };
    PNG.adjustGamma = function(src) {
      if (src.gamma) {
        for (let y = 0; y < src.height; y++) {
          for (let x = 0; x < src.width; x++) {
            let idx = src.width * y + x << 2;
            for (let i = 0; i < 3; i++) {
              let sample = src.data[idx + i] / 255;
              sample = Math.pow(sample, 1 / 2.2 / src.gamma);
              src.data[idx + i] = Math.round(sample * 255);
            }
          }
        }
        src.gamma = 0;
      }
    };
    PNG.prototype.adjustGamma = function() {
      PNG.adjustGamma(this);
    };
  }
});

// node_modules/qrcode/lib/renderer/utils.js
var require_utils2 = __commonJS({
  "node_modules/qrcode/lib/renderer/utils.js"(exports2) {
    function hex2rgba(hex) {
      if (typeof hex === "number") {
        hex = hex.toString();
      }
      if (typeof hex !== "string") {
        throw new Error("Color should be defined as hex string");
      }
      let hexCode = hex.slice().replace("#", "").split("");
      if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
        throw new Error("Invalid hex color: " + hex);
      }
      if (hexCode.length === 3 || hexCode.length === 4) {
        hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
          return [c, c];
        }));
      }
      if (hexCode.length === 6) hexCode.push("F", "F");
      const hexValue = parseInt(hexCode.join(""), 16);
      return {
        r: hexValue >> 24 & 255,
        g: hexValue >> 16 & 255,
        b: hexValue >> 8 & 255,
        a: hexValue & 255,
        hex: "#" + hexCode.slice(0, 6).join("")
      };
    }
    exports2.getOptions = function getOptions(options) {
      if (!options) options = {};
      if (!options.color) options.color = {};
      const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
      const width = options.width && options.width >= 21 ? options.width : void 0;
      const scale = options.scale || 4;
      return {
        width,
        scale: width ? 4 : scale,
        margin,
        color: {
          dark: hex2rgba(options.color.dark || "#000000ff"),
          light: hex2rgba(options.color.light || "#ffffffff")
        },
        type: options.type,
        rendererOpts: options.rendererOpts || {}
      };
    };
    exports2.getScale = function getScale(qrSize, opts) {
      return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
    };
    exports2.getImageWidth = function getImageWidth(qrSize, opts) {
      const scale = exports2.getScale(qrSize, opts);
      return Math.floor((qrSize + opts.margin * 2) * scale);
    };
    exports2.qrToImageData = function qrToImageData(imgData, qr, opts) {
      const size = qr.modules.size;
      const data = qr.modules.data;
      const scale = exports2.getScale(size, opts);
      const symbolSize = Math.floor((size + opts.margin * 2) * scale);
      const scaledMargin = opts.margin * scale;
      const palette = [opts.color.light, opts.color.dark];
      for (let i = 0; i < symbolSize; i++) {
        for (let j = 0; j < symbolSize; j++) {
          let posDst = (i * symbolSize + j) * 4;
          let pxColor = opts.color.light;
          if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
            const iSrc = Math.floor((i - scaledMargin) / scale);
            const jSrc = Math.floor((j - scaledMargin) / scale);
            pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
          }
          imgData[posDst++] = pxColor.r;
          imgData[posDst++] = pxColor.g;
          imgData[posDst++] = pxColor.b;
          imgData[posDst] = pxColor.a;
        }
      }
    };
  }
});

// node_modules/qrcode/lib/renderer/png.js
var require_png2 = __commonJS({
  "node_modules/qrcode/lib/renderer/png.js"(exports2) {
    var fs = require("fs");
    var PNG = require_png().PNG;
    var Utils = require_utils2();
    exports2.render = function render(qrData, options) {
      const opts = Utils.getOptions(options);
      const pngOpts = opts.rendererOpts;
      const size = Utils.getImageWidth(qrData.modules.size, opts);
      pngOpts.width = size;
      pngOpts.height = size;
      const pngImage = new PNG(pngOpts);
      Utils.qrToImageData(pngImage.data, qrData, opts);
      return pngImage;
    };
    exports2.renderToDataURL = function renderToDataURL(qrData, options, cb) {
      if (typeof cb === "undefined") {
        cb = options;
        options = void 0;
      }
      exports2.renderToBuffer(qrData, options, function(err, output) {
        if (err) cb(err);
        let url = "data:image/png;base64,";
        url += output.toString("base64");
        cb(null, url);
      });
    };
    exports2.renderToBuffer = function renderToBuffer(qrData, options, cb) {
      if (typeof cb === "undefined") {
        cb = options;
        options = void 0;
      }
      const png = exports2.render(qrData, options);
      const buffer = [];
      png.on("error", cb);
      png.on("data", function(data) {
        buffer.push(data);
      });
      png.on("end", function() {
        cb(null, Buffer.concat(buffer));
      });
      png.pack();
    };
    exports2.renderToFile = function renderToFile(path, qrData, options, cb) {
      if (typeof cb === "undefined") {
        cb = options;
        options = void 0;
      }
      let called = false;
      const done = (...args) => {
        if (called) return;
        called = true;
        cb.apply(null, args);
      };
      const stream = fs.createWriteStream(path);
      stream.on("error", done);
      stream.on("close", done);
      exports2.renderToFileStream(stream, qrData, options);
    };
    exports2.renderToFileStream = function renderToFileStream(stream, qrData, options) {
      const png = exports2.render(qrData, options);
      png.pack().pipe(stream);
    };
  }
});

// node_modules/qrcode/lib/renderer/utf8.js
var require_utf8 = __commonJS({
  "node_modules/qrcode/lib/renderer/utf8.js"(exports2) {
    var Utils = require_utils2();
    var BLOCK_CHAR = {
      WW: " ",
      WB: "\u2584",
      BB: "\u2588",
      BW: "\u2580"
    };
    var INVERTED_BLOCK_CHAR = {
      BB: " ",
      BW: "\u2584",
      WW: "\u2588",
      WB: "\u2580"
    };
    function getBlockChar(top, bottom, blocks) {
      if (top && bottom) return blocks.BB;
      if (top && !bottom) return blocks.BW;
      if (!top && bottom) return blocks.WB;
      return blocks.WW;
    }
    exports2.render = function(qrData, options, cb) {
      const opts = Utils.getOptions(options);
      let blocks = BLOCK_CHAR;
      if (opts.color.dark.hex === "#ffffff" || opts.color.light.hex === "#000000") {
        blocks = INVERTED_BLOCK_CHAR;
      }
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      let output = "";
      let hMargin = Array(size + opts.margin * 2 + 1).join(blocks.WW);
      hMargin = Array(opts.margin / 2 + 1).join(hMargin + "\n");
      const vMargin = Array(opts.margin + 1).join(blocks.WW);
      output += hMargin;
      for (let i = 0; i < size; i += 2) {
        output += vMargin;
        for (let j = 0; j < size; j++) {
          const topModule = data[i * size + j];
          const bottomModule = data[(i + 1) * size + j];
          output += getBlockChar(topModule, bottomModule, blocks);
        }
        output += vMargin + "\n";
      }
      output += hMargin.slice(0, -1);
      if (typeof cb === "function") {
        cb(null, output);
      }
      return output;
    };
    exports2.renderToFile = function renderToFile(path, qrData, options, cb) {
      if (typeof cb === "undefined") {
        cb = options;
        options = void 0;
      }
      const fs = require("fs");
      const utf8 = exports2.render(qrData, options);
      fs.writeFile(path, utf8, cb);
    };
  }
});

// node_modules/qrcode/lib/renderer/terminal/terminal.js
var require_terminal = __commonJS({
  "node_modules/qrcode/lib/renderer/terminal/terminal.js"(exports2) {
    exports2.render = function(qrData, options, cb) {
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      const black = "\x1B[40m  \x1B[0m";
      const white = "\x1B[47m  \x1B[0m";
      let output = "";
      const hMargin = Array(size + 3).join(white);
      const vMargin = Array(2).join(white);
      output += hMargin + "\n";
      for (let i = 0; i < size; ++i) {
        output += white;
        for (let j = 0; j < size; j++) {
          output += data[i * size + j] ? black : white;
        }
        output += vMargin + "\n";
      }
      output += hMargin + "\n";
      if (typeof cb === "function") {
        cb(null, output);
      }
      return output;
    };
  }
});

// node_modules/qrcode/lib/renderer/terminal/terminal-small.js
var require_terminal_small = __commonJS({
  "node_modules/qrcode/lib/renderer/terminal/terminal-small.js"(exports2) {
    var backgroundWhite = "\x1B[47m";
    var backgroundBlack = "\x1B[40m";
    var foregroundWhite = "\x1B[37m";
    var foregroundBlack = "\x1B[30m";
    var reset = "\x1B[0m";
    var lineSetupNormal = backgroundWhite + foregroundBlack;
    var lineSetupInverse = backgroundBlack + foregroundWhite;
    var createPalette = function(lineSetup, foregroundWhite2, foregroundBlack2) {
      return {
        // 1 ... white, 2 ... black, 0 ... transparent (default)
        "00": reset + " " + lineSetup,
        "01": reset + foregroundWhite2 + "\u2584" + lineSetup,
        "02": reset + foregroundBlack2 + "\u2584" + lineSetup,
        10: reset + foregroundWhite2 + "\u2580" + lineSetup,
        11: " ",
        12: "\u2584",
        20: reset + foregroundBlack2 + "\u2580" + lineSetup,
        21: "\u2580",
        22: "\u2588"
      };
    };
    var mkCodePixel = function(modules2, size, x, y) {
      const sizePlus = size + 1;
      if (x >= sizePlus || y >= sizePlus || y < -1 || x < -1) return "0";
      if (x >= size || y >= size || y < 0 || x < 0) return "1";
      const idx = y * size + x;
      return modules2[idx] ? "2" : "1";
    };
    var mkCode = function(modules2, size, x, y) {
      return mkCodePixel(modules2, size, x, y) + mkCodePixel(modules2, size, x, y + 1);
    };
    exports2.render = function(qrData, options, cb) {
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      const inverse = !!(options && options.inverse);
      const lineSetup = options && options.inverse ? lineSetupInverse : lineSetupNormal;
      const white = inverse ? foregroundBlack : foregroundWhite;
      const black = inverse ? foregroundWhite : foregroundBlack;
      const palette = createPalette(lineSetup, white, black);
      const newLine = reset + "\n" + lineSetup;
      let output = lineSetup;
      for (let y = -1; y < size + 1; y += 2) {
        for (let x = -1; x < size; x++) {
          output += palette[mkCode(data, size, x, y)];
        }
        output += palette[mkCode(data, size, size, y)] + newLine;
      }
      output += reset;
      if (typeof cb === "function") {
        cb(null, output);
      }
      return output;
    };
  }
});

// node_modules/qrcode/lib/renderer/terminal.js
var require_terminal2 = __commonJS({
  "node_modules/qrcode/lib/renderer/terminal.js"(exports2) {
    var big = require_terminal();
    var small = require_terminal_small();
    exports2.render = function(qrData, options, cb) {
      if (options && options.small) {
        return small.render(qrData, options, cb);
      }
      return big.render(qrData, options, cb);
    };
  }
});

// node_modules/qrcode/lib/renderer/svg-tag.js
var require_svg_tag = __commonJS({
  "node_modules/qrcode/lib/renderer/svg-tag.js"(exports2) {
    var Utils = require_utils2();
    function getColorAttrib(color, attrib) {
      const alpha = color.a / 255;
      const str = attrib + '="' + color.hex + '"';
      return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
    }
    function svgCmd(cmd, x, y) {
      let str = cmd + x;
      if (typeof y !== "undefined") str += " " + y;
      return str;
    }
    function qrToPath(data, size, margin) {
      let path = "";
      let moveBy = 0;
      let newRow = false;
      let lineLength = 0;
      for (let i = 0; i < data.length; i++) {
        const col = Math.floor(i % size);
        const row = Math.floor(i / size);
        if (!col && !newRow) newRow = true;
        if (data[i]) {
          lineLength++;
          if (!(i > 0 && col > 0 && data[i - 1])) {
            path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
            moveBy = 0;
            newRow = false;
          }
          if (!(col + 1 < size && data[i + 1])) {
            path += svgCmd("h", lineLength);
            lineLength = 0;
          }
        } else {
          moveBy++;
        }
      }
      return path;
    }
    exports2.render = function render(qrData, options, cb) {
      const opts = Utils.getOptions(options);
      const size = qrData.modules.size;
      const data = qrData.modules.data;
      const qrcodesize = size + opts.margin * 2;
      const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
      const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
      const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
      const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
      const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + "</svg>\n";
      if (typeof cb === "function") {
        cb(null, svgTag);
      }
      return svgTag;
    };
  }
});

// node_modules/qrcode/lib/renderer/svg.js
var require_svg = __commonJS({
  "node_modules/qrcode/lib/renderer/svg.js"(exports2) {
    var svgTagRenderer = require_svg_tag();
    exports2.render = svgTagRenderer.render;
    exports2.renderToFile = function renderToFile(path, qrData, options, cb) {
      if (typeof cb === "undefined") {
        cb = options;
        options = void 0;
      }
      const fs = require("fs");
      const svgTag = exports2.render(qrData, options);
      const xmlStr = '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' + svgTag;
      fs.writeFile(path, xmlStr, cb);
    };
  }
});

// node_modules/qrcode/lib/renderer/canvas.js
var require_canvas = __commonJS({
  "node_modules/qrcode/lib/renderer/canvas.js"(exports2) {
    var Utils = require_utils2();
    function clearCanvas(ctx2, canvas, size) {
      ctx2.clearRect(0, 0, canvas.width, canvas.height);
      if (!canvas.style) canvas.style = {};
      canvas.height = size;
      canvas.width = size;
      canvas.style.height = size + "px";
      canvas.style.width = size + "px";
    }
    function getCanvasElement() {
      try {
        return document.createElement("canvas");
      } catch (e) {
        throw new Error("You need to specify a canvas element");
      }
    }
    exports2.render = function render(qrData, canvas, options) {
      let opts = options;
      let canvasEl = canvas;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!canvas) {
        canvasEl = getCanvasElement();
      }
      opts = Utils.getOptions(opts);
      const size = Utils.getImageWidth(qrData.modules.size, opts);
      const ctx2 = canvasEl.getContext("2d");
      const image = ctx2.createImageData(size, size);
      Utils.qrToImageData(image.data, qrData, opts);
      clearCanvas(ctx2, canvasEl, size);
      ctx2.putImageData(image, 0, 0);
      return canvasEl;
    };
    exports2.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
      let opts = options;
      if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
        opts = canvas;
        canvas = void 0;
      }
      if (!opts) opts = {};
      const canvasEl = exports2.render(qrData, canvas, opts);
      const type = opts.type || "image/png";
      const rendererOpts = opts.rendererOpts || {};
      return canvasEl.toDataURL(type, rendererOpts.quality);
    };
  }
});

// node_modules/qrcode/lib/browser.js
var require_browser = __commonJS({
  "node_modules/qrcode/lib/browser.js"(exports2) {
    var canPromise = require_can_promise();
    var QRCode2 = require_qrcode();
    var CanvasRenderer = require_canvas();
    var SvgRenderer = require_svg_tag();
    function renderCanvas(renderFunc, canvas, text, opts, cb) {
      const args = [].slice.call(arguments, 1);
      const argsNum = args.length;
      const isLastArgCb = typeof args[argsNum - 1] === "function";
      if (!isLastArgCb && !canPromise()) {
        throw new Error("Callback required as last argument");
      }
      if (isLastArgCb) {
        if (argsNum < 2) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 2) {
          cb = text;
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 3) {
          if (canvas.getContext && typeof cb === "undefined") {
            cb = opts;
            opts = void 0;
          } else {
            cb = opts;
            opts = text;
            text = canvas;
            canvas = void 0;
          }
        }
      } else {
        if (argsNum < 1) {
          throw new Error("Too few arguments provided");
        }
        if (argsNum === 1) {
          text = canvas;
          canvas = opts = void 0;
        } else if (argsNum === 2 && !canvas.getContext) {
          opts = text;
          text = canvas;
          canvas = void 0;
        }
        return new Promise(function(resolve, reject) {
          try {
            const data = QRCode2.create(text, opts);
            resolve(renderFunc(data, canvas, opts));
          } catch (e) {
            reject(e);
          }
        });
      }
      try {
        const data = QRCode2.create(text, opts);
        cb(null, renderFunc(data, canvas, opts));
      } catch (e) {
        cb(e);
      }
    }
    exports2.create = QRCode2.create;
    exports2.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
    exports2.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
    exports2.toString = renderCanvas.bind(null, function(data, _, opts) {
      return SvgRenderer.render(data, opts);
    });
  }
});

// node_modules/qrcode/lib/server.js
var require_server = __commonJS({
  "node_modules/qrcode/lib/server.js"(exports2) {
    var canPromise = require_can_promise();
    var QRCode2 = require_qrcode();
    var PngRenderer = require_png2();
    var Utf8Renderer = require_utf8();
    var TerminalRenderer = require_terminal2();
    var SvgRenderer = require_svg();
    function checkParams(text, opts, cb) {
      if (typeof text === "undefined") {
        throw new Error("String required as first argument");
      }
      if (typeof cb === "undefined") {
        cb = opts;
        opts = {};
      }
      if (typeof cb !== "function") {
        if (!canPromise()) {
          throw new Error("Callback required as last argument");
        } else {
          opts = cb || {};
          cb = null;
        }
      }
      return {
        opts,
        cb
      };
    }
    function getTypeFromFilename(path) {
      return path.slice((path.lastIndexOf(".") - 1 >>> 0) + 2).toLowerCase();
    }
    function getRendererFromType(type) {
      switch (type) {
        case "svg":
          return SvgRenderer;
        case "txt":
        case "utf8":
          return Utf8Renderer;
        case "png":
        case "image/png":
        default:
          return PngRenderer;
      }
    }
    function getStringRendererFromType(type) {
      switch (type) {
        case "svg":
          return SvgRenderer;
        case "terminal":
          return TerminalRenderer;
        case "utf8":
        default:
          return Utf8Renderer;
      }
    }
    function render(renderFunc, text, params) {
      if (!params.cb) {
        return new Promise(function(resolve, reject) {
          try {
            const data = QRCode2.create(text, params.opts);
            return renderFunc(data, params.opts, function(err, data2) {
              return err ? reject(err) : resolve(data2);
            });
          } catch (e) {
            reject(e);
          }
        });
      }
      try {
        const data = QRCode2.create(text, params.opts);
        return renderFunc(data, params.opts, params.cb);
      } catch (e) {
        params.cb(e);
      }
    }
    exports2.create = QRCode2.create;
    exports2.toCanvas = require_browser().toCanvas;
    exports2.toString = function toString(text, opts, cb) {
      const params = checkParams(text, opts, cb);
      const type = params.opts ? params.opts.type : void 0;
      const renderer = getStringRendererFromType(type);
      return render(renderer.render, text, params);
    };
    exports2.toDataURL = function toDataURL(text, opts, cb) {
      const params = checkParams(text, opts, cb);
      const renderer = getRendererFromType(params.opts.type);
      return render(renderer.renderToDataURL, text, params);
    };
    exports2.toBuffer = function toBuffer(text, opts, cb) {
      const params = checkParams(text, opts, cb);
      const renderer = getRendererFromType(params.opts.type);
      return render(renderer.renderToBuffer, text, params);
    };
    exports2.toFile = function toFile(path, text, opts, cb) {
      if (typeof path !== "string" || !(typeof text === "string" || typeof text === "object")) {
        throw new Error("Invalid argument");
      }
      if (arguments.length < 3 && !canPromise()) {
        throw new Error("Too few arguments provided");
      }
      const params = checkParams(text, opts, cb);
      const type = params.opts.type || getTypeFromFilename(path);
      const renderer = getRendererFromType(type);
      const renderToFile = renderer.renderToFile.bind(null, path);
      return render(renderToFile, text, params);
    };
    exports2.toFileStream = function toFileStream(stream, text, opts) {
      if (arguments.length < 2) {
        throw new Error("Too few arguments provided");
      }
      const params = checkParams(text, opts, stream.emit.bind(stream, "error"));
      const renderer = getRendererFromType("png");
      const renderToFileStream = renderer.renderToFileStream.bind(null, stream);
      render(renderToFileStream, text, params);
    };
  }
});

// node_modules/qrcode/lib/index.js
var require_lib = __commonJS({
  "node_modules/qrcode/lib/index.js"(exports2, module2) {
    module2.exports = require_server();
  }
});

// node_modules/react/cjs/react-jsx-runtime.production.js
var require_react_jsx_runtime_production = __commonJS({
  "node_modules/react/cjs/react-jsx-runtime.production.js"(exports2) {
    "use strict";
    var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element");
    var REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment");
    function jsxProd(type, config, maybeKey) {
      var key = null;
      void 0 !== maybeKey && (key = "" + maybeKey);
      void 0 !== config.key && (key = "" + config.key);
      if ("key" in config) {
        maybeKey = {};
        for (var propName in config)
          "key" !== propName && (maybeKey[propName] = config[propName]);
      } else maybeKey = config;
      config = maybeKey.ref;
      return {
        $$typeof: REACT_ELEMENT_TYPE,
        type,
        key,
        ref: void 0 !== config ? config : null,
        props: maybeKey
      };
    }
    exports2.Fragment = REACT_FRAGMENT_TYPE;
    exports2.jsx = jsxProd;
    exports2.jsxs = jsxProd;
  }
});

// node_modules/react/cjs/react-jsx-runtime.development.js
var require_react_jsx_runtime_development = __commonJS({
  "node_modules/react/cjs/react-jsx-runtime.development.js"(exports2) {
    "use strict";
    "production" !== process.env.NODE_ENV && (function() {
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
          case REACT_VIEW_TRANSITION_TYPE:
            return "ViewTransition";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStack, debugTask) {
        var children = config.children;
        if (void 0 !== children)
          if (isStaticChildren)
            if (isArrayImpl(children)) {
              for (isStaticChildren = 0; isStaticChildren < children.length; isStaticChildren++)
                validateChildKeys(children[isStaticChildren]);
              Object.freeze && Object.freeze(children);
            } else
              console.error(
                "React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead."
              );
          else validateChildKeys(children);
        if (hasOwnProperty.call(config, "key")) {
          children = getComponentNameFromType(type);
          var keys = Object.keys(config).filter(function(k) {
            return "key" !== k;
          });
          isStaticChildren = 0 < keys.length ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
          didWarnAboutKeySpread[children + isStaticChildren] || (keys = 0 < keys.length ? "{" + keys.join(": ..., ") + ": ...}" : "{}", console.error(
            'A props object containing a "key" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />',
            isStaticChildren,
            children,
            keys,
            children
          ), didWarnAboutKeySpread[children + isStaticChildren] = true);
        }
        children = null;
        void 0 !== maybeKey && (checkKeyStringCoercion(maybeKey), children = "" + maybeKey);
        hasValidKey(config) && (checkKeyStringCoercion(config.key), children = "" + config.key);
        if ("key" in config) {
          maybeKey = {};
          for (var propName in config)
            "key" !== propName && (maybeKey[propName] = config[propName]);
        } else maybeKey = config;
        children && defineKeyPropWarningGetter(
          maybeKey,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        return ReactElement(
          type,
          children,
          maybeKey,
          getOwner(),
          debugStack,
          debugTask
        );
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      var React = require_react(), REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = /* @__PURE__ */ Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo"), REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity"), REACT_VIEW_TRANSITION_TYPE = /* @__PURE__ */ Symbol.for("react.view_transition"), REACT_CLIENT_REFERENCE = /* @__PURE__ */ Symbol.for("react.client.reference"), ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, hasOwnProperty = Object.prototype.hasOwnProperty, isArrayImpl = Array.isArray, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      React = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = React.react_stack_bottom_frame.bind(
        React,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutKeySpread = {};
      exports2.Fragment = REACT_FRAGMENT_TYPE;
      exports2.jsx = function(type, config, maybeKey) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        if (trackActualOwner) {
          var previousStackTraceLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 10;
          var debugStackDEV = Error("react-stack-top-frame");
          Error.stackTraceLimit = previousStackTraceLimit;
        } else debugStackDEV = unknownOwnerDebugStack;
        return jsxDEVImpl(
          type,
          config,
          maybeKey,
          false,
          debugStackDEV,
          trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports2.jsxs = function(type, config, maybeKey) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        if (trackActualOwner) {
          var previousStackTraceLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 10;
          var debugStackDEV = Error("react-stack-top-frame");
          Error.stackTraceLimit = previousStackTraceLimit;
        } else debugStackDEV = unknownOwnerDebugStack;
        return jsxDEVImpl(
          type,
          config,
          maybeKey,
          true,
          debugStackDEV,
          trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
    })();
  }
});

// node_modules/react/jsx-runtime.js
var require_jsx_runtime = __commonJS({
  "node_modules/react/jsx-runtime.js"(exports2, module2) {
    "use strict";
    if (process.env.NODE_ENV === "production") {
      module2.exports = require_react_jsx_runtime_production();
    } else {
      module2.exports = require_react_jsx_runtime_development();
    }
  }
});

// src/components/print/receipt/paper.ts
var PAPER_SPEC = {
  A4: {
    widthMm: 210,
    heightMm: 297,
    marginMm: { top: 12, right: 14, bottom: 12, left: 14 },
    cssSize: "A4",
    note: "A4 \xB7 210 \xD7 297 mm \u5355\u9875\u6FC0\u5149"
  },
  dot241: {
    // 241 针式连续纸：宽 241mm 固定，一联单据按 140mm 计（换联单可改此高度）
    widthMm: 241,
    heightMm: 140,
    marginMm: { top: 6, right: 10, bottom: 6, left: 10 },
    cssSize: "241mm 140mm",
    note: "241 \u9488\u5F0F \xB7 241 \xD7 140 mm \u8FDE\u7EED\u7EB8\uFF08\u8054\u5355\uFF09"
  },
  thermal80: {
    widthMm: 80,
    heightMm: null,
    marginMm: { top: 3, right: 3, bottom: 3, left: 3 },
    cssSize: "80mm auto",
    note: "80 \u70ED\u654F \xB7 \u5BBD 80 mm \u5377\u7EB8\uFF0C\u957F\u5EA6\u968F\u5185\u5BB9"
  },
  thermal58: {
    widthMm: 58,
    heightMm: null,
    marginMm: { top: 2, right: 3, bottom: 2, left: 3 },
    cssSize: "58mm auto",
    note: "58 \u70ED\u654F \xB7 \u5BBD 58 mm \u5377\u7EB8\uFF0C\u957F\u5EA6\u968F\u5185\u5BB9"
  }
};
var MM_TO_PX = 96 / 25.4;
var isRollPaper = (kind) => PAPER_SPEC[kind].heightMm == null;
var defaultLayout = (kind) => isRollPaper(kind) ? "receipt" : "sheet";

// src/components/print/receipt/code-size.ts
var DOT_MM = 0.125;
var CODE_SCALE_DOTS = { 1: 3, 2: 4, 3: 6, 4: 8, 5: 10 };
function scaleOf(v) {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 2;
}
var BARCODE_HEIGHT_DOTS = 96;
var dotsToMm = (dots) => dots * DOT_MM;
function printableDots(paper) {
  if (paper === "thermal58") return 384;
  if (paper === "thermal80") return 512;
  const m = PAPER_SPEC[paper].marginMm;
  return Math.round((PAPER_SPEC[paper].widthMm - m.left - m.right) / DOT_MM);
}
function printableMm(paper) {
  return dotsToMm(printableDots(paper));
}
function headDots(paper) {
  return paper === "thermal58" ? 384 : 576;
}
function rollDots(paper) {
  return isRollPaper(paper) ? Math.round(PAPER_SPEC[paper].widthMm / DOT_MM) : 0;
}
function codeBudgetDots(paper, machinePaper) {
  const base = printableDots(paper);
  return isRollPaper(paper) && machinePaper ? Math.min(base, headDots(machinePaper)) : base;
}
function codeOffsetDots(codeDots, paper, machinePaper) {
  const roll = rollDots(paper);
  if (roll === 0) return 0;
  const axis = Math.min(roll, headDots(machinePaper ?? paper));
  return Math.max(0, Math.round((axis - codeDots) / 2));
}
function fitModuleDots(totalModules, maxDots, want) {
  let dots = want;
  while (dots > 1 && totalModules * dots > maxDots) dots -= 1;
  return dots;
}

// src/components/print/receipt/code128.ts
var PATTERNS = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112"
];
var START_B = 104;
var START_C = 105;
var LATCH_C = 99;
var LATCH_B = 100;
var STOP = 106;
var CODE128_QUIET_MODULES = 10;
var isDigit = (ch) => ch >= "0" && ch <= "9";
function valueB(ch) {
  const c = ch.charCodeAt(0);
  return c >= 32 && c <= 127 ? c - 32 : null;
}
function digitRun(data, i) {
  let n = 0;
  while (i + n < data.length && isDigit(data[i + n])) n += 1;
  return n;
}
function encodeCode128(data) {
  if (!data) return null;
  const codes = [];
  let mode;
  if (/^[0-9]+$/.test(data) && data.length % 2 === 0) {
    mode = "C";
    codes.push(START_C);
  } else {
    mode = "B";
    codes.push(START_B);
  }
  let i = 0;
  while (i < data.length) {
    const run = digitRun(data, i);
    if (mode === "C") {
      if (run >= 2) {
        codes.push(Number(data.slice(i, i + 2)));
        i += 2;
      } else {
        mode = "B";
        codes.push(LATCH_B);
      }
      continue;
    }
    if (run >= 4) {
      mode = "C";
      codes.push(LATCH_C);
      continue;
    }
    const v = valueB(data[i]);
    if (v == null) return null;
    codes.push(v);
    i += 1;
  }
  let sum = codes[0];
  for (let j = 1; j < codes.length; j++) sum += j * codes[j];
  codes.push(sum % 103);
  codes.push(STOP);
  return codes;
}
function code128Runs(data) {
  const codes = encodeCode128(data);
  if (!codes) return null;
  const runs2 = [];
  for (const c of codes) {
    for (const ch of PATTERNS[c]) runs2.push(Number(ch));
  }
  return runs2;
}
function measureCode128(data, paper, scale, maxDots) {
  const runs2 = code128Runs(data);
  if (!runs2) return null;
  const body = runs2.reduce((a, b) => a + b, 0);
  const modules2 = body + CODE128_QUIET_MODULES * 2;
  const want = CODE_SCALE_DOTS[scaleOf(scale)];
  const dots = fitModuleDots(modules2, maxDots ?? printableDots(paper), want);
  return { runs: runs2, dots, modules: modules2, widthMm: dotsToMm(modules2 * dots), shrunk: dots !== want };
}

// src/components/print/receipt/render.tsx
var import_react2 = __toESM(require_react(), 1);

// src/lib/constants.ts
var ORDER_STATUS = {
  draft: { label: "\u8349\u7A3F", tone: "neutral", desc: "\u5DF2\u53D6\u53F7\u672A\u8865\u5168\u4FE1\u606F" },
  registered: { label: "\u5DF2\u767B\u8BB0", tone: "neutral", desc: "\u519C\u6237\u3001\u54C1\u79CD\u3001\u8F66\u8F86\u9F50\u5907\uFF0C\u7B49\u5F85\u5316\u9A8C\u6216\u8FC7\u78C5" },
  qc_done: { label: "\u5DF2\u5316\u9A8C", tone: "info", desc: "\u5316\u9A8C\u5B8C\u6210\uFF0C\u5C1A\u65E0\u91CD\u91CF" },
  gross_weighed: { label: "\u5F85\u76AE\u91CD", tone: "info", desc: "\u5DF2\u53D6\u6BDB\u91CD\uFF0C\u7F3A\u76AE\u91CD" },
  tare_weighed: { label: "\u5F85\u6BDB\u91CD", tone: "info", desc: "\u5DF2\u53D6\u76AE\u91CD\uFF0C\u7F3A\u6BDB\u91CD" },
  reweigh: { label: "\u590D\u79F0\u4E2D", tone: "warning", desc: "\u51C0\u91CD\u5DF2\u5B9A\u4F46\u6B63\u5728\u590D\u79F0\u8C03\u6574" },
  to_settle: { label: "\u5F85\u7ED3\u7B97", tone: "info", desc: "\u51C0\u91CD\u4E0E\u7ED3\u7B97\u91CD\u91CF\u786E\u5B9A\uFF0C\u5F85\u7ED3\u7B97" },
  settled: { label: "\u5DF2\u7ED3\u7B97", tone: "info", desc: "\u5DF2\u751F\u6210\u7ED3\u7B97\u5355\uFF0C\u672A\u5FC5\u4ED8\u6E05" },
  paid: { label: "\u5DF2\u4ED8\u6E05", tone: "success", desc: "\u7CAE\u6B3E\u5168\u90E8\u4ED8\u6E05" },
  archived: { label: "\u5DF2\u5F52\u6863", tone: "neutral", desc: "\u65E5\u7ED3\u540E\u7EC8\u6001" },
  voided: { label: "\u5DF2\u4F5C\u5E9F", tone: "danger", desc: "\u4F5C\u4E1A\u4E2D\u9014\u4F5C\u5E9F\uFF0C\u4FDD\u7559\u7559\u75D5" },
  reversed: { label: "\u5DF2\u7EA2\u51B2", tone: "danger", desc: "\u88AB\u7EA2\u51B2\u5355\u62B5\u6D88\u7684\u539F\u5355" },
  rejected: { label: "\u62D2\u6536\u9000\u7CAE", tone: "danger", desc: "\u76EE\u6D4B\u6216\u5316\u9A8C\u5224\u5B9A\u62D2\u6536" }
};
var PLATE_ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789".split("");
var PARTY_TYPE = {
  farmer: "\u519C\u6237",
  large_grower: "\u79CD\u7CAE\u5927\u6237",
  broker: "\u7ECF\u7EAA\u4EBA",
  cooperative: "\u5408\u4F5C\u793E",
  company: "\u4F01\u4E1A"
};
var PAYMENT_METHOD = {
  cash: "\u73B0\u91D1",
  bank: "\u94F6\u884C\u8F6C\u8D26",
  wechat: "\u5FAE\u4FE1",
  alipay: "\u652F\u4ED8\u5B9D",
  transfer: "\u793E\u4FDD\u5361/\u4E00\u5361\u901A",
  credit_writeoff: "\u6302\u8D26\u6838\u9500"
};
var PAYMENT_STATUS = {
  unpaid: { label: "\u672A\u4ED8\u6B3E", tone: "danger" },
  partial: { label: "\u90E8\u5206\u4ED8\u6B3E", tone: "warning" },
  paid: { label: "\u5DF2\u4ED8\u6E05", tone: "success" },
  not_required: { label: "\u65E0\u9700\u4ED8\u6B3E", tone: "neutral" }
};
var GRADES = ["\u4E00\u7B49", "\u4E8C\u7B49", "\u4E09\u7B49", "\u56DB\u7B49", "\u7B49\u5916"];
var QC_DECISION = {
  accept: { label: "\u63A5\u6536", tone: "success" },
  conditional: { label: "\u6761\u4EF6\u63A5\u6536", tone: "warning" },
  reject: { label: "\u62D2\u6536", tone: "danger" }
};
var TEST_METHOD = {
  nir: "\u8FD1\u7EA2\u5916",
  lab: "\u5316\u9A8C\u5BA4",
  visual: "\u76EE\u6D4B"
};

// src/lib/format.ts
var EMPTY = "\u2014";
function group(n, digits) {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}
function nil(v) {
  return v === null || v === void 0 || Number.isNaN(v);
}
function weight(v01kg, withUnit = true) {
  if (nil(v01kg)) return EMPTY;
  const kg = v01kg / 10;
  return `${group(kg, 1)}${withUnit ? " kg" : ""}`;
}
function ton(v01kg, withUnit = true) {
  if (nil(v01kg)) return EMPTY;
  const t = v01kg / 1e4;
  return `${group(t, 3)}${withUnit ? " t" : ""}`;
}
function money(fen, withSymbol = true) {
  if (nil(fen)) return EMPTY;
  const y = fen / 100;
  return `${withSymbol ? "\xA5" : ""}${group(y, 2)}`;
}
function price(fenPerTon) {
  if (nil(fenPerTon)) return EMPTY;
  return `${priceNumber(fenPerTon)} \u5143/\u516C\u65A4`;
}
function toYuanPerKg(fenPerTon) {
  return fenPerTon / 1e3 / 100;
}
function priceNumber(fenPerTon) {
  if (nil(fenPerTon)) return EMPTY;
  return (Math.round(toYuanPerKg(fenPerTon) * 1e3) / 1e3).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3
  });
}
function percent(v001pct, unit = " %") {
  if (nil(v001pct)) return EMPTY;
  return `${group(v001pct / 100, 2)}${unit}`;
}
var CN_NUM = ["\u96F6", "\u58F9", "\u8D30", "\u53C1", "\u8086", "\u4F0D", "\u9646", "\u67D2", "\u634C", "\u7396"];
var CN_UNIT = ["", "\u62FE", "\u4F70", "\u4EDF"];
var CN_SECTION = ["", "\u4E07", "\u4EBF", "\u5146"];
function rmbUpper(fen) {
  if (nil(fen)) return EMPTY;
  if (fen === 0) return "\u4EBA\u6C11\u5E01\u96F6\u5143\u6574";
  const negative = fen < 0;
  const abs = Math.abs(Math.round(fen));
  const jiao = Math.floor(abs / 10) % 10;
  const fenDigit = abs % 10;
  const yuan = Math.floor(abs / 100);
  let body = "";
  if (yuan > 0) {
    const digits = String(yuan).split("").reverse();
    let pendingZero = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      const d = Number(digits[i]);
      const sectionPos = i % 4;
      if (d === 0) {
        if (sectionPos === 0) {
          pendingZero = false;
        } else {
          pendingZero = true;
        }
      } else {
        if (pendingZero) body += "\u96F6";
        pendingZero = false;
        body += CN_NUM[d] + CN_UNIT[sectionPos];
      }
      if (sectionPos === 0) {
        body += CN_SECTION[i / 4] ?? "";
      }
    }
    body += "\u5143";
  }
  if (jiao === 0 && fenDigit === 0) {
    return `${negative ? "\u8D1F" : ""}\u4EBA\u6C11\u5E01${body || ""}\u6574`;
  }
  let tail = "";
  if (jiao > 0) tail += CN_NUM[jiao] + "\u89D2";
  else if (yuan > 0 && fenDigit > 0) tail += "\u96F6";
  if (fenDigit > 0) tail += CN_NUM[fenDigit] + "\u5206";
  return `${negative ? "\u8D1F" : ""}\u4EBA\u6C11\u5E01${body}${tail}`;
}
function parts(iso) {
  const [datePart = "", timePart = ""] = iso.split("T");
  const [y = "", m = "", d = ""] = datePart.split("-");
  const t = timePart.replace(/Z|[+-]\d{2}:\d{2}$/, "");
  const [hh = "00", mm = "00", ss = "00"] = t.split(":");
  return { y, m, d, hh, mm, ss };
}
function dateTime(iso) {
  if (!iso) return EMPTY;
  const p = parts(iso);
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm}:${p.ss}`;
}
function maskIdCard(id) {
  if (!id) return EMPTY;
  if (id.length < 10) return id;
  return `${id.slice(0, 6)}${"*".repeat(id.length - 10)}${id.slice(-4)}`;
}
function varietyLabel(name) {
  return name ? name : "\u672A\u5B9A\u54C1\u79CD";
}

// src/lib/ticket-code.ts
var TICKET_CODE_PREFIX = "BH1:";
function encodeDocCode(docNo) {
  return `${TICKET_CODE_PREFIX}${normalize(docNo)}`;
}
function normalize(raw) {
  return raw.split(/[\r\n]+/)[0].replace(/[\t\b\u0000-\u001f\u007f]/g, "").replace(/\s+/g, "").replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248)).toUpperCase();
}

// src/lib/calc.ts
function roundHalfUp(n) {
  return Math.floor(n + 0.5);
}
function amountFen(settlementWeight01kg2, priceFenPerTon) {
  return roundHalfUp(settlementWeight01kg2 * priceFenPerTon / 1e4);
}
function deductTotal01kg(d) {
  return d.package_deduct_01kg + d.moisture_deduct_01kg + d.impurity_deduct_01kg + d.other_deduct_01kg;
}
function settlementWeight01kg(d) {
  if (d.net_weight_01kg == null) return null;
  return d.net_weight_01kg - deductTotal01kg(d);
}
function goodsAmountFen(settle01kg, priceFenPerTon) {
  if (settle01kg == null || priceFenPerTon == null || settle01kg <= 0) return null;
  return amountFen(settle01kg, priceFenPerTon);
}
function payableFen(goods, deductionFeeFen = 0, advanceFeeFen = 0) {
  if (goods == null) return null;
  return goods - deductionFeeFen + advanceFeeFen;
}
function previewSettlement(input) {
  const settle = settlementWeight01kg(input);
  const goods = goodsAmountFen(settle, input.price_fen_per_ton);
  const payable = payableFen(goods, input.deduction_fee_fen ?? 0, input.advance_fee_fen ?? 0);
  return {
    deductTotal01kg: deductTotal01kg(input),
    settlementWeight01kg: settle,
    goodsAmountFen: goods,
    payableAmountFen: payable,
    /** 禁用结算按钮时必须给原因（05 §4 ⑤），这里把原因一次算清 */
    blocked: blockReason(input, settle)
  };
}
function blockReason(input, settle) {
  if (input.net_weight_01kg == null) return "\u7F3A\u5C11\u6BDB\u91CD\u6216\u76AE\u91CD\uFF0C\u65E0\u6CD5\u7ED3\u7B97";
  if (settle != null && settle <= 0) return "\u6263\u91CD\u540E\u7ED3\u7B97\u91CD\u91CF\u4E0D\u5927\u4E8E 0\uFF0C\u8BF7\u6838\u5BF9\u6263\u9879";
  return null;
}

// src/lib/settle-defaults.ts
function settlePreview(order, qc) {
  if (order.price_fen_per_ton == null || order.net_weight_01kg == null) return null;
  const package_deduct_01kg = order.package_deduct_01kg ?? 0;
  const moisture_deduct_01kg = order.moisture_deduct_01kg || qc?.moisture_deduct_01kg || 0;
  const impurity_deduct_01kg = order.impurity_deduct_01kg || qc?.impurity_deduct_01kg || 0;
  const other_deduct_01kg = order.other_deduct_01kg ?? 0;
  const p = previewSettlement({
    net_weight_01kg: order.net_weight_01kg,
    package_deduct_01kg,
    moisture_deduct_01kg,
    impurity_deduct_01kg,
    other_deduct_01kg,
    price_fen_per_ton: order.price_fen_per_ton,
    deduction_fee_fen: order.deduction_fee_fen ?? 0,
    advance_fee_fen: order.advance_fee_fen ?? 0
  });
  if (p.settlementWeight01kg == null || p.settlementWeight01kg <= 0) return null;
  if (p.goodsAmountFen == null || p.payableAmountFen == null) return null;
  return {
    package_deduct_01kg,
    moisture_deduct_01kg,
    impurity_deduct_01kg,
    other_deduct_01kg,
    deduct_total_01kg: p.deductTotal01kg,
    settlement_weight_01kg: p.settlementWeight01kg,
    goods_amount_fen: p.goodsAmountFen,
    payable_amount_fen: p.payableAmountFen
  };
}

// src/components/print/receipt/scenarios.tsx
var SAMPLE_STATION = {
  id: 1,
  code: "BH2026",
  name: "\u6EE8\u6CB3\u7CAE\u98DF\u6536\u8D2D\u7AD9",
  address: "\u5411\u9633\u8DEF 18 \u53F7",
  phone: "0571-8800 1234"
};
var NAME_MAP = {
  1: "\u5F20\u4F1F\uFF08\u7AD9\u957F\uFF09",
  2: "\u674E\u7EA2\uFF08\u767B\u8BB0\uFF09",
  3: "\u738B\u5F3A\uFF08\u78C5\u5458\uFF09",
  4: "\u9648\u654F\uFF08\u5316\u9A8C\uFF09",
  5: "\u8D75\u78CA\uFF08\u51FA\u7EB3\uFF09"
};
var sampleNames = (id) => id == null ? "\u2014" : NAME_MAP[id] ?? `\u5458\u5DE5${id}`;
var SAMPLE_ORDER = {
  id: 1024,
  order_no: "BD20260912-00317",
  business_date: "2026-09-12",
  status: "paid",
  party_id: 88,
  party_name: "\u5468\u5EFA\u56FD",
  party_type: "farmer",
  id_card_no: "330104197203054419",
  variety_id: 1,
  variety_code: "YG",
  variety_name: "\u665A\u7CB3\u7A3B",
  grade: "\u4E8C\u7B49",
  warehouse_id: 2,
  warehouse_name: "3 \u53F7\u5E73\u623F\u4ED3",
  slot_id: 5,
  slot_label: "A \u533A 2 \u579B",
  vehicle_no: "\u6D59A\xB78F2K6",
  driver_name: "\u5468\u5EFA\u56FD",
  gross_weight_01kg: 61234,
  tare_weight_01kg: 15820,
  net_weight_01kg: 45414,
  package_deduct_01kg: 0,
  package_count: 0,
  moisture_deduct_01kg: 1816,
  impurity_deduct_01kg: 908,
  other_deduct_01kg: 0,
  deduct_total_01kg: 2724,
  settlement_weight_01kg: 42690,
  price_fen_per_ton: 286e3,
  price_list_id: 12,
  price_override_reason: null,
  goods_amount_fen: 12213340,
  deduction_fee_fen: 0,
  advance_fee_fen: 0,
  payable_amount_fen: 12213340,
  paid_amount_fen: 12213340,
  payment_status: "paid",
  payment_method: "cash",
  weight_source: "scale",
  tare_override_by: null,
  tare_override_reason: "\u5B9E\u6D4B\u76AE\u91CD 1582.0kg\uFF0C\u8F83\u6700\u8FD1\u5386\u53F2\u76AE\u91CD 1450.0kg \u504F\u5DEE +9.1%\uFF0C\u8D85\u51FA\u5BB9\u5DEE 3.00%",
  is_manual_pricing: 0,
  reversed_order_id: null,
  reverse_of_id: null,
  qc_report_id: 551,
  registered_by: 2,
  registered_at: "2026-09-12T08:42:10+08:00",
  gross_at: "2026-09-12T08:40:02+08:00",
  tare_at: "2026-09-12T08:51:33+08:00",
  qc_at: "2026-09-12T08:47:15+08:00",
  settled_at: "2026-09-12T09:02:41+08:00",
  paid_at: "2026-09-12T09:03:05+08:00",
  voided_at: null,
  void_reason: null,
  weigher_id: 3,
  inspector_id: 4,
  keeper_id: null,
  remark: "\u519C\u6237\u81EA\u5E26\u7F16\u7EC7\u888B\uFF0C\u5DF2\u5F53\u9762\u70B9\u6E05\u3002",
  created_at: "2026-09-12T08:42:10+08:00"
};
var SAMPLE_QC = {
  id: 551,
  report_no: "QC20260912-00402",
  order_id: 1024,
  order_no: "BD20260912-00317",
  party_name: "\u5468\u5EFA\u56FD",
  sample_no: "YP-317",
  variety_id: 1,
  grade: "\u4E8C\u7B49",
  decision: "accept",
  reject_reason: null,
  moisture_deduct_01kg: 1816,
  impurity_deduct_01kg: 908,
  test_method: "nir",
  is_recheck: 0,
  first_report_id: null,
  is_effective: 1,
  inspector_id: 4,
  inspected_at: "2026-09-12T08:47:15+08:00",
  retention_no: "LY-317",
  retention_until: "2027-03-12",
  indicators: [
    { code: "moisture", name: "\u6C34\u5206", value_num: 1400, value_text: null, unit: "0.01pct", std_value: 1400, over_std: 0, sort_order: 1 },
    { code: "impurity", name: "\u6742\u8D28", value_num: 100, value_text: null, unit: "0.01pct", std_value: 100, over_std: 0, sort_order: 2 },
    { code: "unsound", name: "\u4E0D\u5B8C\u5584\u7C92", value_num: 320, value_text: null, unit: "0.01pct", std_value: 500, over_std: 0, sort_order: 3 },
    { code: "bulk_density", name: "\u5BB9\u91CD", value_num: 760, value_text: null, unit: "gL", std_value: 720, over_std: 0, sort_order: 4 },
    { code: "odor", name: "\u6C14\u5473", value_num: null, value_text: "\u6B63\u5E38\u65E0\u5F02\u5473", unit: "text", std_value: null, over_std: 0, sort_order: 5 }
  ],
  remark: null
};
var SAMPLE_SETTLEMENT = {
  id: 77,
  settle_no: "JS20260912-00009",
  party_id: 88,
  party_name: "\u5468\u5EFA\u56FD",
  business_date: "2026-09-12",
  period_from: "2026-09-12",
  period_to: "2026-09-12",
  order_count: 2,
  total_net_01kg: 90120,
  total_deduct_01kg: 5240,
  total_settle_01kg: 84880,
  total_goods_fen: 24270120,
  total_deduction_fen: 0,
  total_advance_fen: 0,
  payable_fen: 24270120,
  paid_fen: 24270120,
  payment_status: "paid",
  main_method: "cash",
  payee_name: "\u5468\u5EFA\u56FD",
  signed_by_party: 1,
  status: "normal",
  settled_at: "2026-09-12T17:20:09+08:00",
  settler_id: 5,
  orders: [
    { order_id: 1024, order_no: "BD20260912-00317", goods_amount_fen: 12213340, price_fen_per_ton: 286e3, settlement_weight_01kg: 42690, seq: 1 },
    { order_id: 1025, order_no: "BD20260912-00335", goods_amount_fen: 12056780, price_fen_per_ton: 284e3, settlement_weight_01kg: 42190, seq: 2 }
  ],
  remark: null
};
var SAMPLE_PAYMENT = {
  id: 905,
  pay_no: "FK20260912-00121",
  settlement_id: 77,
  settle_no: "JS20260912-00009",
  order_id: null,
  order_no: null,
  party_id: 88,
  party_name: "\u5468\u5EFA\u56FD",
  amount_fen: 24270120,
  method: "cash",
  trade_no: null,
  payee_name: "\u5468\u5EFA\u56FD",
  paid_at: "2026-09-12T17:21:33+08:00",
  operator_id: 5,
  voucher_no: "PZ-20260912-121",
  reversed: 0,
  remark: "\u5F53\u65E5\u4E24\u5355\u5408\u5E76\u4ED8\u6E05"
};
var SAMPLE_LEDGER = [
  {
    seq: 1,
    business_date: "2026-09-12",
    order_no: "BD20260912-00317",
    party_name: "\u5468\u5EFA\u56FD",
    party_type: "farmer",
    id_card_no: "330104197203054419",
    address: "\u57CE\u4E1C\u6751 3 \u7EC4",
    variety_name: "\u665A\u7CB3\u7A3B",
    grade: "\u4E8C\u7B49",
    vehicle_no: "\u6D59A\xB78F2K6",
    warehouse_name: "3 \u53F7\u5E73\u623F\u4ED3",
    gross_weight_01kg: 61234,
    tare_weight_01kg: 15820,
    net_weight_01kg: 45414,
    deduct_total_01kg: 2724,
    settlement_weight_01kg: 42690,
    moisture_001pct: 1400,
    impurity_001pct: 100,
    price_fen_per_ton: 286e3,
    goods_amount_fen: 12213340,
    deduction_fee_fen: 0,
    payable_amount_fen: 12213340,
    paid_amount_fen: 12213340,
    credit_amount_fen: 0,
    payment_method: "cash",
    weight_source: "scale",
    weigher_name: "\u738B\u5F3A",
    inspector_name: "\u9648\u654F",
    settled: true
  },
  {
    seq: 2,
    business_date: "2026-09-12",
    order_no: "BD20260912-00335",
    party_name: "\u5468\u5EFA\u56FD",
    party_type: "farmer",
    id_card_no: "330104197203054419",
    address: "\u57CE\u4E1C\u6751 3 \u7EC4",
    variety_name: "\u665A\u7CB3\u7A3B",
    grade: "\u4E8C\u7B49",
    vehicle_no: "\u6D59A\xB78F2K6",
    warehouse_name: "3 \u53F7\u5E73\u623F\u4ED3",
    gross_weight_01kg: 60410,
    tare_weight_01kg: 15820,
    net_weight_01kg: 44590,
    deduct_total_01kg: 2510,
    settlement_weight_01kg: 42190,
    moisture_001pct: 1410,
    impurity_001pct: 100,
    price_fen_per_ton: 284e3,
    goods_amount_fen: 12056780,
    deduction_fee_fen: 0,
    payable_amount_fen: 12056780,
    paid_amount_fen: 12056780,
    credit_amount_fen: 0,
    payment_method: "cash",
    weight_source: "scale",
    weigher_name: "\u738B\u5F3A",
    inspector_name: "\u9648\u654F",
    settled: true
  },
  {
    seq: 3,
    business_date: "2026-09-12",
    order_no: "BD20260912-00340",
    party_name: "\u7EFF\u6E90\u5408\u4F5C\u793E",
    party_type: "cooperative",
    id_card_no: "91330100MA2XXXXXX4",
    address: "\u5DE5\u4E1A\u56ED 9 \u53F7",
    variety_name: "\u5C0F\u9EA6",
    grade: "\u4E00\u7B49",
    vehicle_no: "\u6D59B\xB76T9L1",
    warehouse_name: "\u7ACB\u7B52\u4ED3",
    gross_weight_01kg: 48900,
    tare_weight_01kg: 17200,
    net_weight_01kg: 31700,
    deduct_total_01kg: 1200,
    settlement_weight_01kg: 30500,
    moisture_001pct: 1250,
    impurity_001pct: 80,
    price_fen_per_ton: 272e3,
    goods_amount_fen: 8296e3,
    deduction_fee_fen: 0,
    payable_amount_fen: 8296e3,
    paid_amount_fen: 5e6,
    credit_amount_fen: 3296e3,
    payment_method: "transfer",
    weight_source: "scale",
    weigher_name: "\u738B\u5F3A",
    inspector_name: "\u9648\u654F",
    settled: true
  }
];
var SAMPLE_DAILY = {
  date: "2026-09-12",
  rows: [
    {
      variety_name: "\u665A\u7CB3\u7A3B",
      variety_code: "YG",
      orders: 42,
      parties: 31,
      gross_01kg: 256e4,
      tare_01kg: 68e4,
      net_01kg: 188e4,
      deduct_01kg: 112e3,
      settle_01kg: 1768e3,
      goods_fen: 50592e4,
      deduction_fee_fen: 0,
      payable_fen: 50592e4,
      paid_fen: 4982e5,
      credit_fen: 772e4,
      avg_moisture_001pct: 1380,
      manual_count: 2,
      reject_count: 1
    },
    {
      variety_name: "\u5C0F\u9EA6",
      variety_code: "XM",
      orders: 18,
      parties: 12,
      gross_01kg: 98e4,
      tare_01kg: 312e3,
      net_01kg: 668e3,
      deduct_01kg: 26e3,
      settle_01kg: 642e3,
      goods_fen: 174624e3,
      deduction_fee_fen: 0,
      payable_fen: 174624e3,
      paid_fen: 174624e3,
      credit_fen: 0,
      avg_moisture_001pct: 1260,
      manual_count: 0,
      reject_count: 0
    }
  ],
  total: {
    orders: 60,
    parties: 43,
    net_01kg: 2548e3,
    settle_01kg: 241e4,
    goods_fen: 680544e3,
    payable_fen: 680544e3,
    paid_fen: 672824e3,
    credit_fen: 772e4
  },
  prevDayNet_01kg: 239e4,
  lastWeekNet_01kg: 261e4
};
function mk(key, label, group2, kind) {
  return { key, label, group: group2, kind };
}
function indicatorValue(qc, code) {
  return qc?.indicators.find((i) => i.code === code)?.value_num ?? null;
}
var EST_SUFFIX = "\uFF08\u9884\u4F30\uFF09";
function settledOrPreview(o, qc, settled, preview) {
  if (o.payable_amount_fen != null) return settled;
  const p = settlePreview(o, qc);
  return p == null ? settled : `${preview(p)}${EST_SUFFIX}`;
}
var WEIGH_FIELDS = [
  mk("party_name", "\u552E\u7CAE\u4EBA", "\u552E\u7CAE\u4EBA", "text"),
  mk("id_card_masked", "\u8EAB\u4EFD\u8BC1\u53F7(\u8131\u654F)", "\u552E\u7CAE\u4EBA", "text"),
  mk("party_type_label", "\u8EAB\u4EFD", "\u552E\u7CAE\u4EBA", "enum"),
  mk("vehicle_no", "\u8F66\u724C", "\u8F66\u8F86", "text"),
  mk("driver_name", "\u9A7E\u9A76\u5458", "\u8F66\u8F86", "text"),
  mk("variety_name", "\u54C1\u79CD", "\u54C1\u79CD\u7B49\u7EA7", "text"),
  mk("grade", "\u7B49\u7EA7(\u4E1A\u52A1)", "\u54C1\u79CD\u7B49\u7EA7", "enum"),
  mk("grade_from_qc", "\u7B49\u7EA7(\u5316\u9A8C)", "\u54C1\u79CD\u7B49\u7EA7", "enum"),
  mk("moisture_pct", "\u6C34\u5206", "\u54C1\u79CD\u7B49\u7EA7", "percent"),
  mk("impurity_pct", "\u6742\u8D28", "\u54C1\u79CD\u7B49\u7EA7", "percent"),
  mk("warehouse", "\u4ED3\u623F/\u8D27\u4F4D", "\u4ED3\u50A8\u72B6\u6001", "text"),
  mk("status_label", "\u72B6\u6001", "\u4ED3\u50A8\u72B6\u6001", "enum"),
  mk("weight_source_label", "\u79F0\u91CD\u65B9\u5F0F", "\u4ED3\u50A8\u72B6\u6001", "enum"),
  mk("gross_weight", "\u6BDB\u91CD", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("tare_weight", "\u76AE\u91CD", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("net_weight", "\u51C0\u91CD", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("package_deduct", "\u888B\u91CD\u6263\u91CF", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("moisture_deduct", "\u6263\u6C34", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("impurity_deduct", "\u6263\u6742", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("other_deduct", "\u5176\u4ED6\u6263", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("deduct_total", "\u6263\u91CD\u5408\u8BA1", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("settlement_weight", "\u7ED3\u7B97\u91CD\u91CF", "\u91CD\u91CF\u660E\u7EC6", "weight"),
  mk("settlement_weight_ton", "\u7ED3\u7B97\u91CD\u91CF(\u5428)", "\u91CD\u91CF\u660E\u7EC6", "ton"),
  // 皮重偏差超容差的醒目提醒：捕获不被拦下，但票面必须印得出来（迎检与事后核对都看这一栏）
  mk("tare_warning", "\u76AE\u91CD\u8B66\u793A", "\u91CD\u91CF\u660E\u7EC6", "text"),
  mk("price_per_kg", "\u5355\u4EF7(\u5143/\u516C\u65A4)", "\u91D1\u989D", "money"),
  mk("goods_amount", "\u7CAE\u6B3E", "\u91D1\u989D", "money"),
  mk("deduction_fee", "\u6263\u6B3E", "\u91D1\u989D", "money"),
  mk("advance_fee", "\u9884\u4ED8\u6B3E", "\u91D1\u989D", "money"),
  mk("payable_amount", "\u5E94\u4ED8", "\u91D1\u989D", "money"),
  mk("paid_amount", "\u5DF2\u4ED8", "\u91D1\u989D", "money"),
  mk("payable_upper", "\u5E94\u4ED8\u5927\u5199", "\u91D1\u989D", "text"),
  mk("payment_status_label", "\u4ED8\u6B3E\u72B6\u6001", "\u91D1\u989D", "enum"),
  mk("payment_method_label", "\u4ED8\u6B3E\u65B9\u5F0F", "\u91D1\u989D", "enum"),
  mk("price_override_reason", "\u6539\u4EF7\u539F\u56E0", "\u91D1\u989D", "text"),
  mk("registered_at", "\u5236\u5355\u65F6\u95F4", "\u65F6\u95F4\u7EBF", "datetime"),
  mk("gross_at", "\u6BDB\u91CD\u65F6\u95F4", "\u65F6\u95F4\u7EBF", "datetime"),
  mk("tare_at", "\u76AE\u91CD\u65F6\u95F4", "\u65F6\u95F4\u7EBF", "datetime"),
  mk("qc_at", "\u5316\u9A8C\u65F6\u95F4", "\u65F6\u95F4\u7EBF", "datetime"),
  mk("settled_at", "\u7ED3\u7B97\u65F6\u95F4", "\u65F6\u95F4\u7EBF", "datetime"),
  mk("paid_at", "\u4ED8\u6B3E\u65F6\u95F4", "\u65F6\u95F4\u7EBF", "datetime"),
  mk("weigher", "\u78C5\u5458", "\u7F72\u540D", "text"),
  mk("inspector", "\u5316\u9A8C\u5458", "\u7F72\u540D", "text"),
  mk("registered_by_label", "\u767B\u8BB0/\u7ED3\u7B97\u5458", "\u7F72\u540D", "text"),
  mk("remark", "\u5907\u6CE8", "\u7F72\u540D", "text"),
  // 不是给人读的一栏：码单右下角那个码的内容，结算窗口扫它定位本单（02 §F1.4 先打票后集中结算）
  mk("ticket_code", "\u51ED\u7968\u4E8C\u7EF4\u7801\u8F7D\u8377", "\u51ED\u636E", "text")
];
var WEIGH_GROUPS = ["\u552E\u7CAE\u4EBA", "\u8F66\u8F86", "\u54C1\u79CD\u7B49\u7EA7", "\u4ED3\u50A8\u72B6\u6001", "\u91CD\u91CF\u660E\u7EC6", "\u91D1\u989D", "\u65F6\u95F4\u7EBF", "\u7F72\u540D", "\u51ED\u636E"];
var QC_FIELDS = [
  mk("order_no", "\u5BF9\u5E94\u78C5\u5355", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("party_name", "\u552E\u7CAE\u4EBA", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("sample_no", "\u6837\u54C1\u53F7", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("test_method_label", "\u68C0\u6D4B\u65B9\u6CD5", "\u57FA\u672C\u4FE1\u606F", "enum"),
  mk("grade", "\u7B49\u7EA7", "\u5224\u5B9A", "enum"),
  mk("decision_label", "\u5224\u5B9A", "\u5224\u5B9A", "enum"),
  mk("moisture_deduct", "\u6263\u6C34", "\u5224\u5B9A", "weight"),
  mk("impurity_deduct", "\u6263\u6742", "\u5224\u5B9A", "weight"),
  mk("reject_reason", "\u62D2\u6536\u539F\u56E0", "\u5224\u5B9A", "text"),
  mk("retention_no", "\u7559\u6837\u53F7", "\u7559\u6837", "text"),
  mk("retention_until", "\u7559\u6837\u81F3", "\u7559\u6837", "text"),
  mk("is_recheck", "\u662F\u5426\u590D\u68C0", "\u7559\u6837", "enum"),
  mk("inspector", "\u5316\u9A8C\u5458", "\u7F72\u540D", "text"),
  mk("weigher", "\u53F8\u78C5\u5458\u786E\u8BA4", "\u7F72\u540D", "text")
];
var QC_TABLES = [
  {
    dataset: "indicators",
    label: "\u8D28\u68C0\u6307\u6807",
    columns: [
      { key: "name", label: "\u6307\u6807", kind: "text" },
      { key: "value", label: "\u5B9E\u6D4B", kind: "text" },
      { key: "std", label: "\u56FD\u6807\u57FA\u51C6", kind: "text" },
      { key: "over", label: "\u6BD4\u8F83", kind: "enum" },
      { key: "note", label: "\u8BF4\u660E", kind: "text" }
    ]
  }
];
var SETTLE_FIELDS = [
  mk("payee_name", "\u6536\u6B3E\u4EBA", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("period", "\u8986\u76D6\u671F\u95F4", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("order_count", "\u78C5\u5355\u6570", "\u57FA\u672C\u4FE1\u606F", "enum"),
  mk("status_label", "\u72B6\u6001", "\u57FA\u672C\u4FE1\u606F", "enum"),
  mk("settle_code", "\u51ED\u5355\u4E8C\u7EF4\u7801\u8F7D\u8377", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("total_goods", "\u7CAE\u6B3E\u5408\u8BA1", "\u91D1\u989D", "money"),
  mk("total_deduction", "\u6263\u6B3E\u5408\u8BA1", "\u91D1\u989D", "money"),
  mk("payable", "\u5E94\u4ED8\u5408\u8BA1", "\u91D1\u989D", "money"),
  mk("paid", "\u5DF2\u4ED8\u5408\u8BA1", "\u91D1\u989D", "money"),
  mk("unpaid", "\u672A\u4ED8\u5408\u8BA1", "\u91D1\u989D", "money"),
  mk("payable_upper", "\u5E94\u4ED8\u5927\u5199", "\u91D1\u989D", "text"),
  mk("main_method_label", "\u4ED8\u6B3E\u65B9\u5F0F", "\u91D1\u989D", "enum"),
  mk("settler", "\u7ED3\u7B97\u5458", "\u7F72\u540D", "text"),
  mk("settled_at", "\u7ED3\u7B97\u65F6\u95F4", "\u65F6\u95F4\u7EBF", "datetime")
];
var SETTLE_TABLES = [
  {
    dataset: "orders",
    label: "\u7ED3\u7B97\u78C5\u5355\u660E\u7EC6",
    columns: [
      { key: "order_no", label: "\u78C5\u5355\u53F7", kind: "text" },
      { key: "settlement_weight", label: "\u7ED3\u7B97\u91CD\u91CF", kind: "weight" },
      { key: "price", label: "\u5355\u4EF7", kind: "money" },
      { key: "goods_amount", label: "\u91D1\u989D", kind: "money" }
    ]
  }
];
var PAY_FIELDS = [
  mk("pay_no", "\u4ED8\u6B3E\u6D41\u6C34\u53F7", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("paid_at", "\u4ED8\u6B3E\u65F6\u95F4", "\u57FA\u672C\u4FE1\u606F", "datetime"),
  mk("party_name", "\u6536\u6B3E\u4EBA", "\u57FA\u672C\u4FE1\u606F", "text"),
  mk("method_label", "\u4ED8\u6B3E\u65B9\u5F0F", "\u57FA\u672C\u4FE1\u606F", "enum"),
  mk("trade_no", "\u4EA4\u6613\u6D41\u6C34", "\u5173\u8054", "text"),
  mk("voucher_no", "\u51ED\u8BC1\u53F7", "\u5173\u8054", "text"),
  mk("settle_no", "\u7ED3\u7B97\u5355\u53F7", "\u5173\u8054", "text"),
  mk("order_no", "\u78C5\u5355\u53F7", "\u5173\u8054", "text"),
  mk("amount", "\u91D1\u989D", "\u91D1\u989D", "money"),
  mk("amount_upper", "\u91D1\u989D\u5927\u5199", "\u91D1\u989D", "text"),
  mk("operator", "\u7ECF\u624B\u4EBA", "\u7F72\u540D", "text"),
  mk("reversed_label", "\u72B6\u6001", "\u7F72\u540D", "enum")
];
var LEDGER_TABLES = [
  {
    dataset: "ledgerRows",
    label: "\u53F0\u8D26\u660E\u7EC6\u884C",
    columns: [
      { key: "business_date", label: "\u4E1A\u52A1\u65E5\u671F", kind: "text" },
      { key: "order_no", label: "\u78C5\u5355\u53F7", kind: "text" },
      { key: "party_name", label: "\u552E\u7CAE\u4EBA", kind: "text" },
      { key: "variety_name", label: "\u54C1\u79CD", kind: "text" },
      { key: "net", label: "\u51C0\u91CD", kind: "weight" },
      { key: "payable", label: "\u5E94\u4ED8", kind: "money" },
      { key: "paid", label: "\u5DF2\u4ED8", kind: "money" },
      { key: "weigher", label: "\u78C5\u5458", kind: "text" }
    ]
  }
];
var LEDGER_FIELDS = [
  mk("period", "\u7EDF\u8BA1\u671F\u95F4", "\u6C47\u603B", "text"),
  mk("row_count", "\u53F0\u8D26\u884C\u6570", "\u6C47\u603B", "enum"),
  mk("sum_net", "\u51C0\u91CD\u5408\u8BA1", "\u6C47\u603B", "weight"),
  mk("sum_settle", "\u7ED3\u7B97\u91CD\u91CF\u5408\u8BA1", "\u6C47\u603B", "weight"),
  mk("sum_goods", "\u7CAE\u6B3E\u5408\u8BA1", "\u6C47\u603B", "money"),
  mk("sum_payable", "\u5E94\u4ED8\u5408\u8BA1", "\u6C47\u603B", "money"),
  mk("sum_paid", "\u5DF2\u4ED8\u5408\u8BA1", "\u6C47\u603B", "money"),
  mk("sum_credit", "\u672A\u4ED8\u5408\u8BA1", "\u6C47\u603B", "money")
];
var DAILY_TABLES = [
  {
    dataset: "dailyVariety",
    label: "\u5206\u54C1\u79CD\u65E5\u62A5",
    columns: [
      { key: "variety_name", label: "\u54C1\u79CD", kind: "text" },
      { key: "orders", label: "\u5355\u6570", kind: "enum" },
      { key: "net", label: "\u51C0\u91CD", kind: "weight" },
      { key: "goods", label: "\u7CAE\u6B3E", kind: "money" },
      { key: "payable", label: "\u5E94\u4ED8", kind: "money" },
      { key: "paid", label: "\u5DF2\u4ED8", kind: "money" },
      { key: "credit", label: "\u6302\u8D26", kind: "money" },
      { key: "manual", label: "\u624B\u5F55", kind: "enum" },
      { key: "reject", label: "\u62D2\u6536", kind: "enum" }
    ]
  }
];
var DAILY_FIELDS = [
  mk("date", "\u4E1A\u52A1\u65E5\u671F", "\u6C47\u603B", "text"),
  mk("orders", "\u5355\u6570", "\u6C47\u603B", "enum"),
  mk("parties", "\u552E\u7CAE\u4EBA\u6570", "\u6C47\u603B", "enum"),
  mk("net", "\u51C0\u91CD\u5408\u8BA1", "\u6C47\u603B", "weight"),
  mk("settle", "\u7ED3\u7B97\u91CD\u91CF\u5408\u8BA1", "\u6C47\u603B", "weight"),
  mk("goods", "\u7CAE\u6B3E\u5408\u8BA1", "\u6C47\u603B", "money"),
  mk("payable", "\u5E94\u4ED8\u5408\u8BA1", "\u6C47\u603B", "money"),
  mk("paid", "\u5DF2\u4ED8\u5408\u8BA1", "\u6C47\u603B", "money"),
  mk("credit", "\u6302\u8D26\u5408\u8BA1", "\u6C47\u603B", "money")
];
var WEIGH_SPEC = {
  id: "weigh_order",
  label: "\u6536\u8D2D\u8FC7\u78C5\u5355",
  entry: "\u5DE5\u4F5C\u53F0\u8FC7\u78C5\u5B8C\u6210 / \u78C5\u5355\u8BE6\u60C5 / \u5FEB\u6377\u8BE6\u60C5",
  fields: WEIGH_FIELDS,
  groups: WEIGH_GROUPS,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, order: SAMPLE_ORDER, qc: SAMPLE_QC }),
  resolveField: (key, ctx2) => {
    const o = ctx2.order;
    if (!o) return "\u2014";
    const qc = ctx2.qc;
    switch (key) {
      case "party_name":
        return o.party_name;
      case "id_card_masked":
        return maskIdCard(o.id_card_no);
      case "party_type_label":
        return PARTY_TYPE[o.party_type];
      case "vehicle_no":
        return o.vehicle_no ?? "\u2014";
      case "driver_name":
        return o.driver_name ?? "\u2014";
      case "variety_name":
        return varietyLabel(o.variety_name);
      case "grade":
        return o.grade ?? "\u672A\u5B9A\u7EA7";
      case "grade_from_qc":
        return qc?.grade ?? "\u672A\u5316\u9A8C";
      case "moisture_pct":
        return percent(indicatorValue(qc, "moisture"));
      case "impurity_pct":
        return percent(indicatorValue(qc, "impurity"));
      case "warehouse":
        return `${o.warehouse_name ?? "\u2014"}${o.slot_label ? ` / ${o.slot_label}` : ""}`;
      case "status_label":
        return ORDER_STATUS[o.status].label;
      case "weight_source_label":
        return o.weight_source === "scale" ? "\u5730\u78C5\u8BFB\u6570" : "\u4EBA\u5DE5\u624B\u5F55";
      // 超容差皮重：捕获仍有效，但票面必须把提醒印出来（与详情页醒目条同源，读 tare_override_reason）
      case "tare_warning":
        return o.tare_override_reason ?? "\u2014";
      case "gross_weight":
        return weight(o.gross_weight_01kg);
      case "tare_weight":
        return weight(o.tare_weight_01kg);
      case "net_weight":
        return weight(o.net_weight_01kg);
      // 袋重与其他扣没有第二个来源（结算那一刻由人当场填），票面照磅单现值印，不标预估
      case "package_deduct":
        return weight(o.package_deduct_01kg);
      // 扣水/扣杂在未结算时磅单那两列还是 0，而真实会扣的是**化验建议**（`settleDefaults` 的
      // 兜底顺序就是"磅单值优先、化验建议其次"）。若不印化验建议，票面会出现"扣水 0.0kg
      // 却按 12.5kg 扣了钱"——预估应付与扣重栏当场自相矛盾，所以整组一起走预估。
      case "moisture_deduct":
        return settledOrPreview(o, qc, weight(o.moisture_deduct_01kg), (p) => weight(p.moisture_deduct_01kg));
      case "impurity_deduct":
        return settledOrPreview(o, qc, weight(o.impurity_deduct_01kg), (p) => weight(p.impurity_deduct_01kg));
      case "other_deduct":
        return weight(o.other_deduct_01kg);
      case "deduct_total":
        return settledOrPreview(o, qc, weight(o.deduct_total_01kg), (p) => weight(p.deduct_total_01kg));
      case "settlement_weight":
        return settledOrPreview(o, qc, weight(o.settlement_weight_01kg), (p) => weight(p.settlement_weight_01kg));
      case "settlement_weight_ton":
        return settledOrPreview(o, qc, ton(o.settlement_weight_01kg), (p) => ton(p.settlement_weight_01kg));
      // 单价是**确定值**：制单那一刻就按价目表落过价，磅房事后改的也落在这同一列上
      // （见 `orders.rs::create_order` / `set_price`）。所以票面这一栏不再是"—"。
      case "price_per_kg":
        return price(o.price_fen_per_ton);
      case "goods_amount":
        return settledOrPreview(o, qc, money(o.goods_amount_fen), (p) => money(p.goods_amount_fen));
      case "deduction_fee":
        return money(o.deduction_fee_fen);
      case "advance_fee":
        return money(o.advance_fee_fen);
      case "payable_amount":
        return settledOrPreview(o, qc, money(o.payable_amount_fen), (p) => money(p.payable_amount_fen));
      case "paid_amount":
        return money(o.paid_amount_fen);
      case "payable_upper":
        return settledOrPreview(o, qc, rmbUpper(o.payable_amount_fen), (p) => rmbUpper(p.payable_amount_fen));
      // 未结算的单印"无需付款"是错的（客户正是要来领钱）；它此刻的真实状态就是"待结算"
      case "payment_status_label":
        return o.payable_amount_fen == null ? "\u5F85\u7ED3\u7B97" : PAYMENT_STATUS[o.payment_status].label;
      case "payment_method_label":
        return o.payment_method ? PAYMENT_METHOD[o.payment_method] : "\u2014";
      case "price_override_reason":
        return o.price_override_reason ?? "\u2014";
      case "registered_at":
        return dateTime(o.registered_at);
      case "gross_at":
        return dateTime(o.gross_at);
      case "tare_at":
        return dateTime(o.tare_at);
      case "qc_at":
        return dateTime(o.qc_at);
      case "settled_at":
        return dateTime(o.settled_at);
      case "paid_at":
        return dateTime(o.paid_at);
      case "weigher":
        return ctx2.names(o.weigher_id);
      case "inspector":
        return ctx2.names(o.inspector_id);
      case "registered_by_label":
        return ctx2.names(o.registered_by);
      case "remark":
        return o.remark ?? "\u2014";
      // 载荷只有一个定位符：票先打、价后算，金额进码等于让客户自己改价；证号进码等于把 PII 印在流通纸上
      case "ticket_code":
        return encodeDocCode(o.order_no);
      default:
        return "\u2014";
    }
  }
};
var QC_SPEC = {
  id: "quality_report",
  label: "\u8D28\u68C0\u5355",
  entry: "\u5316\u9A8C\u5B8C\u6210 / \u8D28\u68C0\u8BE6\u60C5 / \u5FEB\u6377\u8BE6\u60C5",
  fields: QC_FIELDS,
  groups: ["\u57FA\u672C\u4FE1\u606F", "\u5224\u5B9A", "\u7559\u6837", "\u7F72\u540D"],
  tables: QC_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, qc: SAMPLE_QC, order: SAMPLE_ORDER }),
  resolveField: (key, ctx2) => {
    const r = ctx2.qc;
    if (!r) return "\u2014";
    switch (key) {
      case "order_no":
        return r.order_no;
      case "party_name":
        return r.party_name;
      case "sample_no":
        return r.sample_no;
      case "test_method_label":
        return TEST_METHOD[r.test_method];
      case "grade":
        return r.grade ? GRADES.includes(r.grade) ? r.grade : "\u2014" : "\u672A\u5B9A\u7EA7";
      case "decision_label":
        return QC_DECISION[r.decision].label;
      case "moisture_deduct":
        return weight(r.moisture_deduct_01kg);
      case "impurity_deduct":
        return weight(r.impurity_deduct_01kg);
      case "reject_reason":
        return r.reject_reason ?? "\u2014";
      case "retention_no":
        return r.retention_no ?? "\u2014";
      case "retention_until":
        return r.retention_until ?? "\u2014";
      case "is_recheck":
        return r.is_recheck ? "\u590D\u68C0\u5355" : "\u9996\u68C0";
      case "inspector":
        return ctx2.names(r.inspector_id);
      case "weigher":
        return ctx2.names(r.order_id ? ctx2.order?.weigher_id : null);
      default:
        return "\u2014";
    }
  },
  tableRows: (dataset, ctx2) => {
    if (dataset !== "indicators" || !ctx2.qc) return [];
    return ctx2.qc.indicators.map((it) => {
      const meta = it.std_value;
      return {
        name: it.name,
        value: it.unit === "text" ? it.value_text ?? "\u2014" : percent(it.value_num),
        std: meta == null ? "\u2014" : percent(meta),
        over: it.over_std === 1 ? it.unit === "gL" ? "\u2193 \u4F4E" : "\u2191 \u8D85" : "\u5408\u683C",
        note: it.code === "odor" ? it.value_text ?? "\u2014" : "\u6309 GB 2715 \u9650\u91CF"
      };
    });
  }
};
var SETTLE_SPEC = {
  id: "settlement_voucher",
  label: "\u7ED3\u7B97\u51ED\u8BC1",
  entry: "\u7ED3\u7B97\u5355\u751F\u6210 / \u7ED3\u7B97\u5355\u8BE6\u60C5",
  fields: SETTLE_FIELDS,
  groups: ["\u57FA\u672C\u4FE1\u606F", "\u91D1\u989D", "\u7F72\u540D", "\u65F6\u95F4\u7EBF"],
  tables: SETTLE_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, settlement: SAMPLE_SETTLEMENT }),
  resolveField: (key, ctx2) => {
    const s = ctx2.settlement;
    if (!s) return "\u2014";
    switch (key) {
      case "payee_name":
        return s.payee_name;
      case "period":
        return `${s.period_from} \u81F3 ${s.period_to}`;
      case "order_count":
        return `${s.order_count} \u5F20`;
      case "status_label":
        return s.payment_status === "paid" ? "\u5DF2\u4ED8\u6E05" : s.payment_status === "partial" ? "\u90E8\u5206\u4ED8\u6B3E" : "\u672A\u4ED8\u6B3E";
      // 挂账的凭证日后要拿回来核销，同一套载荷契约，扫码侧按 JS 前缀认出它是结算单
      case "settle_code":
        return encodeDocCode(s.settle_no);
      case "total_goods":
        return money(s.total_goods_fen);
      case "total_deduction":
        return money(s.total_deduction_fen);
      case "payable":
        return money(s.payable_fen);
      case "paid":
        return money(s.paid_fen);
      case "unpaid":
        return money(s.payable_fen - s.paid_fen);
      case "payable_upper":
        return rmbUpper(s.payable_fen);
      case "main_method_label":
        return s.main_method ? PAYMENT_METHOD[s.main_method] : "\u6302\u8D26";
      case "settler":
        return ctx2.names(s.settler_id);
      case "settled_at":
        return dateTime(s.settled_at);
      default:
        return "\u2014";
    }
  },
  tableRows: (dataset, ctx2) => {
    if (dataset !== "orders" || !ctx2.settlement) return [];
    return ctx2.settlement.orders.map((o) => ({
      order_no: o.order_no,
      settlement_weight: weight(o.settlement_weight_01kg),
      price: price(o.price_fen_per_ton),
      goods_amount: money(o.goods_amount_fen)
    }));
  }
};
var PAY_SPEC = {
  id: "payment_receipt",
  label: "\u4ED8\u6B3E\u5C0F\u7968",
  entry: "\u51FA\u7EB3\u767B\u8BB0\u4ED8\u6B3E / \u4ED8\u6B3E\u4E0E\u6302\u8D26\u9875",
  fields: PAY_FIELDS,
  groups: ["\u57FA\u672C\u4FE1\u606F", "\u5173\u8054", "\u91D1\u989D", "\u7F72\u540D"],
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, payment: SAMPLE_PAYMENT, settlement: SAMPLE_SETTLEMENT }),
  resolveField: (key, ctx2) => {
    const p = ctx2.payment;
    if (!p) return "\u2014";
    switch (key) {
      case "pay_no":
        return p.pay_no;
      case "paid_at":
        return dateTime(p.paid_at);
      case "party_name":
        return p.party_name;
      case "method_label":
        return PAYMENT_METHOD[p.method];
      case "trade_no":
        return p.trade_no ?? "\u2014";
      case "voucher_no":
        return p.voucher_no ?? "\u2014";
      case "settle_no":
        return p.settle_no ?? "\u2014";
      case "order_no":
        return p.order_no ?? "\u2014";
      case "amount":
        return money(p.amount_fen);
      case "amount_upper":
        return rmbUpper(p.amount_fen);
      case "operator":
        return ctx2.names(p.operator_id);
      case "reversed_label":
        return p.reversed === 1 ? "\u5DF2\u51B2\u9500" : "\u6709\u6548";
      default:
        return "\u2014";
    }
  }
};
var LEDGER_SPEC = {
  id: "ledger",
  label: "\u6536\u8D2D\u660E\u7EC6\u53F0\u8D26",
  entry: "\u62A5\u8868\u4E2D\u5FC3 \u2192 \u6536\u8D2D\u660E\u7EC6\u53F0\u8D26\u6253\u5370",
  fields: LEDGER_FIELDS,
  groups: ["\u6C47\u603B"],
  tables: LEDGER_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, ledgerRows: SAMPLE_LEDGER }),
  resolveField: (key, ctx2) => {
    const rows = ctx2.ledgerRows ?? [];
    const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
    switch (key) {
      case "period":
        return rows.length ? `${rows[0].business_date} \u8D77` : "\u2014";
      case "row_count":
        return `${rows.length} \u884C`;
      case "sum_net":
        return weight(sum((r) => r.net_weight_01kg ?? 0));
      case "sum_settle":
        return weight(sum((r) => r.settlement_weight_01kg ?? 0));
      case "sum_goods":
        return money(sum((r) => r.goods_amount_fen ?? 0));
      case "sum_payable":
        return money(sum((r) => r.payable_amount_fen ?? 0));
      case "sum_paid":
        return money(sum((r) => r.paid_amount_fen ?? 0));
      case "sum_credit":
        return money(sum((r) => r.credit_amount_fen ?? 0));
      default:
        return "\u2014";
    }
  },
  tableRows: (dataset, ctx2) => {
    if (dataset !== "ledgerRows") return [];
    return (ctx2.ledgerRows ?? []).map((r) => ({
      business_date: r.business_date,
      order_no: r.order_no,
      party_name: r.party_name,
      variety_name: r.variety_name,
      net: weight(r.net_weight_01kg),
      payable: money(r.payable_amount_fen),
      paid: money(r.paid_amount_fen),
      weigher: r.weigher_name
    }));
  }
};
var DAILY_SPEC = {
  id: "daily_report",
  label: "\u6536\u8D2D\u65E5\u62A5\u8868",
  entry: "\u62A5\u8868\u4E2D\u5FC3 \u2192 \u65E5\u62A5\u6253\u5370",
  fields: DAILY_FIELDS,
  groups: ["\u6C47\u603B"],
  tables: DAILY_TABLES,
  sampleContext: () => ({ station: SAMPLE_STATION, names: sampleNames, daily: SAMPLE_DAILY }),
  resolveField: (key, ctx2) => {
    const d = ctx2.daily;
    if (!d) return "\u2014";
    const t = d.total;
    switch (key) {
      case "date":
        return d.date;
      case "orders":
        return `${t.orders} \u5355`;
      case "parties":
        return `${t.parties} \u4EBA`;
      case "net":
        return weight(t.net_01kg);
      case "settle":
        return weight(t.settle_01kg);
      case "goods":
        return money(t.goods_fen);
      case "payable":
        return money(t.payable_fen);
      case "paid":
        return money(t.paid_fen);
      case "credit":
        return money(t.credit_fen);
      default:
        return "\u2014";
    }
  },
  tableRows: (dataset, ctx2) => {
    if (dataset !== "dailyVariety" || !ctx2.daily) return [];
    return ctx2.daily.rows.map((r) => ({
      variety_name: r.variety_name,
      orders: `${r.orders}`,
      net: weight(r.net_01kg),
      goods: money(r.goods_fen),
      payable: money(r.payable_fen),
      paid: money(r.paid_fen),
      credit: money(r.credit_fen),
      manual: `${r.manual_count}`,
      reject: `${r.reject_count}`
    }));
  }
};
var SCENARIOS = {
  weigh_order: WEIGH_SPEC,
  quality_report: QC_SPEC,
  settlement_voucher: SETTLE_SPEC,
  payment_receipt: PAY_SPEC,
  ledger: LEDGER_SPEC,
  daily_report: DAILY_SPEC
};
var SCENARIO_ENTRIES = Object.values(SCENARIOS).map((s) => ({ scenario: s.id, label: s.label, entry: s.entry }));
function getSpec(scenario) {
  return SCENARIOS[scenario];
}

// src/components/print/receipt/QrGraphic.tsx
var import_react = __toESM(require_react(), 1);
var import_qrcode = __toESM(require_lib(), 1);
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var QUIET = 4;
function buildQr(m) {
  try {
    const qr = import_qrcode.default.create(m, { errorCorrectionLevel: "H" });
    return { size: qr.modules.size, data: qr.modules.data };
  } catch {
    return null;
  }
}
function qrSideDots(text, scale) {
  const built = buildQr(text.trim());
  if (!built) return null;
  return (built.size + QUIET * 2) * CODE_SCALE_DOTS[scale];
}

// src/components/print/receipt/BarcodeGraphic.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime(), 1);

// src/components/print/receipt/render.tsx
var import_jsx_runtime3 = __toESM(require_jsx_runtime(), 1);
var DOC_BY_SCENARIO = {
  weigh_order: (c) => c.order ? { docNo: c.order.order_no, dateText: c.order.business_date } : null,
  quality_report: (c) => c.qc ? { docNo: c.qc.report_no, dateText: c.qc.inspected_at.slice(0, 10) } : null,
  settlement_voucher: (c) => c.settlement ? { docNo: c.settlement.settle_no, dateText: c.settlement.business_date } : null,
  payment_receipt: (c) => c.payment ? { docNo: c.payment.pay_no, dateText: c.payment.paid_at.slice(0, 10) } : null,
  daily_report: (c) => c.daily ? { docNo: `\u65E5\u62A5 ${c.daily.date}`, dateText: c.daily.date } : null,
  ledger: (c) => c.ledgerRows?.length ? { docNo: `\u53F0\u8D26 ${c.ledgerRows[0].business_date}`, dateText: c.ledgerRows[0].business_date } : null
};
function docMeta(ctx2, scenario) {
  if (scenario) {
    const hit = DOC_BY_SCENARIO[scenario](ctx2);
    if (hit) return hit;
  }
  switch (ctx2.order ? "weigh" : ctx2.qc ? "qc" : ctx2.settlement ? "settle" : ctx2.payment ? "pay" : ctx2.daily ? "daily" : "ledger") {
    case "weigh":
      return { docNo: ctx2.order.order_no, dateText: ctx2.order.business_date };
    case "qc":
      return { docNo: ctx2.qc.report_no, dateText: ctx2.qc.inspected_at.slice(0, 10) };
    case "settle":
      return { docNo: ctx2.settlement.settle_no, dateText: ctx2.settlement.business_date };
    case "pay":
      return { docNo: ctx2.payment.pay_no, dateText: ctx2.payment.paid_at.slice(0, 10) };
    case "daily":
      return { docNo: `\u65E5\u62A5 ${ctx2.daily.date}`, dateText: ctx2.daily.date };
    default:
      return { docNo: ctx2.ledgerRows?.length ? `\u53F0\u8D26 ${ctx2.ledgerRows[0].business_date}` : "\u53F0\u8D26", dateText: ctx2.ledgerRows?.[0]?.business_date ?? "" };
  }
}
function kvClusters(spec, fields, ctx2) {
  const clusters2 = [];
  for (const key of fields) {
    const def = spec.fields.find((f) => f.key === key);
    const row = { key, label: def?.label ?? key, kind: def?.kind ?? "text", value: spec.resolveField(key, ctx2) };
    const group2 = def?.group ?? "";
    const prev = clusters2[clusters2.length - 1];
    if (prev && prev.group === group2) prev.rows.push(row);
    else clusters2.push({ group: group2, rows: [row] });
  }
  return clusters2;
}

// src/components/print/receipt/escpos.ts
function asText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
function fillText(tpl2, resolve) {
  return tpl2.replace(/\{\{(.+?)\}\}/g, (_, key) => resolve(key.trim()));
}
function receiptLines(template, ctx2, opts) {
  const spec = getSpec(template.scenario);
  const { docNo, dateText } = docMeta(ctx2, template.scenario);
  const machine = opts?.machinePaper;
  const out = [];
  out.push({ kind: "text", text: ctx2.station.name, align: "center", bold: true, wide: 2, tall: 2 });
  out.push({ kind: "text", text: template.title, align: "center", bold: true });
  if (template.showReprintBadge && ctx2.reprint) {
    out.push({ kind: "text", text: "\u3010\u8865\u6253\uFF0C\u5DF2\u7ECF\u7AD9\u957F\u6388\u6743\u3011", align: "center", bold: true });
  }
  if (template.copyNote) out.push({ kind: "text", text: template.copyNote, align: "center" });
  out.push({ kind: "rule" });
  out.push({ kind: "kv", label: "\u5355\u53F7", value: docNo });
  out.push({ kind: "kv", label: "\u65E5\u671F", value: dateText });
  out.push({ kind: "rule" });
  for (const sec of template.sections) {
    if (sec.kind === "kv") {
      const fields = sec.fields ?? [];
      if (fields.length === 0) continue;
      if (sec.title) out.push({ kind: "text", text: sec.title, bold: true });
      const clusters2 = kvClusters(spec, fields, ctx2);
      const titled = clusters2.length > 1;
      for (const c of clusters2) {
        if (titled && c.group) out.push({ kind: "text", text: c.group, bold: true });
        for (const r of c.rows) out.push({ kind: "kv", label: r.label, value: asText(r.value) });
      }
      continue;
    }
    if (sec.kind === "table") {
      const table = spec.tables?.find((t) => t.dataset === sec.dataset);
      if (!table) continue;
      const cols = (sec.columns ?? table.columns.map((c) => c.key)).map((k) => table.columns.find((c) => c.key === k)).filter((c) => !!c);
      if (cols.length === 0) continue;
      if (sec.title) out.push({ kind: "text", text: sec.title, bold: true });
      const rows = spec.tableRows?.(table.dataset, ctx2) ?? [];
      if (rows.length === 0) {
        out.push({ kind: "text", text: "\u6682\u65E0\u6570\u636E" });
        continue;
      }
      for (const row of rows) {
        const cells = cols.map((c) => asText(row[c.key] ?? "\u2014"));
        const [head, ...rest] = cells;
        if (rest.length === 0) out.push({ kind: "text", text: head });
        else out.push({ kind: "kv", label: head, value: rest.join("  ") });
      }
      continue;
    }
    if (sec.kind === "sign") {
      const signers = sec.signers ?? [];
      if (signers.length === 0) continue;
      if (sec.title) out.push({ kind: "text", text: sec.title, bold: true });
      for (const s of signers) out.push({ kind: "kv", label: s, value: "\uFF3F\uFF3F\uFF3F\uFF3F\uFF3F\uFF3F" });
      continue;
    }
    if (sec.kind === "qr") {
      const payload = fillText(sec.text ?? "", (key) => asText(spec.resolveField(key, ctx2))).trim();
      if (!payload) continue;
      const style = sec.codeStyle ?? "qr";
      const scale = scaleOf(sec.qrScale);
      const maxDots = codeBudgetDots(template.paper, machine);
      const pad = (codeDots) => codeOffsetDots(codeDots, template.paper, machine);
      if (style !== "barcode") {
        const side = qrSideDots(payload, scale);
        out.push({ kind: "qr", text: payload, size: CODE_SCALE_DOTS[scale], padLeft: side == null ? 0 : pad(side) });
      }
      if (style !== "qr") {
        const geo = measureCode128(payload, template.paper, scale, maxDots);
        if (geo) {
          out.push({
            kind: "barcode",
            runs: geo.runs,
            dots: geo.dots,
            height: BARCODE_HEIGHT_DOTS,
            padLeft: pad(geo.modules * geo.dots)
          });
        }
      }
      if (sec.qrCaption) out.push({ kind: "text", text: payload, align: "center" });
      continue;
    }
    if (sec.kind === "text") {
      const text = fillText(sec.text ?? "", (key) => asText(spec.resolveField(key, ctx2)));
      out.push({ kind: "text", text });
    }
  }
  out.push({ kind: "rule" });
  if (template.copyNote) out.push({ kind: "text", text: template.copyNote, align: "center" });
  out.push({ kind: "text", text: ctx2.station.code, align: "right" });
  return out;
}

// src/components/print/receipt/defaults.ts
var BASELINE = "2026-09-12T00:00:00+08:00";
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function withLayout(t) {
  return { ...t, layout: t.layout ?? defaultLayout(t.paper) };
}
function buildTemplate(scenario) {
  switch (scenario) {
    case "weigh_order":
      return {
        scenario,
        name: "\u8FC7\u78C5\u5355\uFF08\u9ED8\u8BA4\uFF09",
        paper: "A4",
        title: "\u6536\u8D2D\u7801\u5355\uFF08\u8FC7\u78C5\u5355\uFF09",
        copyNote: "\u7B2C\u4E00\u8054 \u5B58\u6839\uFF08\u7CAE\u7AD9\u7559\u5B58\uFF09",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          {
            id: uid(),
            kind: "kv",
            // 不写区块标题：票面上每一段的小标题由字段自己的分组带出（见 render.tsx 的 kvClusters）
            fields: [
              "party_name",
              "id_card_masked",
              "party_type_label",
              "vehicle_no",
              "variety_name",
              "grade",
              "moisture_pct",
              "impurity_pct",
              "warehouse",
              "status_label",
              "weight_source_label",
              "gross_weight",
              "tare_weight",
              "net_weight",
              "package_deduct",
              "moisture_deduct",
              "impurity_deduct",
              "other_deduct",
              "deduct_total",
              "settlement_weight",
              "settlement_weight_ton",
              "tare_warning",
              "price_per_kg",
              "goods_amount",
              "deduction_fee",
              "payable_amount",
              "paid_amount",
              "payable_upper",
              "payment_status_label",
              "payment_method_label"
            ]
          },
          { id: uid(), kind: "text", text: "\u5907\u6CE8\uFF1A{{remark}}" },
          {
            id: uid(),
            kind: "qr",
            title: "\u51ED\u7968\u7ED3\u7B97\u7801",
            text: "{{ticket_code}}",
            qrCaption: true,
            required: true
          },
          // 价已经在票上了（制单那一刻就按价目表带过挂牌价，见 `orders.rs::create_order`），
          // 所以窗口那一步是"核对扣项、确认金额、领款"，不再说"算价"——票面与话术得对得上，
          // 客户照着票念的时候不能出现票上有的东西窗口却说没有
          { id: uid(), kind: "text", text: "\u7ED3\u7B97\uFF1A\u51ED\u672C\u7968\u53F3\u4E0B\u89D2\u7684\u7801\u5230\u7ED3\u7B97\u7A97\u53E3\u786E\u8BA4\u6263\u9879\u4E0E\u91D1\u989D\u540E\u9886\u6B3E\uFF0C\u65E0\u9700\u91CD\u65B0\u8FC7\u78C5\uFF1B\u7968\u9762\u6807\u300C\u9884\u4F30\u300D\u7684\u91D1\u989D\u4EE5\u7A97\u53E3\u786E\u8BA4\u7684\u4E3A\u51C6\uFF1B\u7968\u9762\u4E22\u5931\u8BF7\u5230\u78C5\u623F\u8865\u6253\u3002" },
          { id: uid(), kind: "sign", signers: ["\u78C5\u5458", "\u5316\u9A8C\u5458", "\u7ED3\u7B97\u5458", "\u552E\u7CAE\u4EBA\u7B7E\u5B57"] }
        ]
      };
    case "quality_report":
      return {
        scenario,
        name: "\u8D28\u68C0\u5355\uFF08\u9ED8\u8BA4\uFF09",
        paper: "A4",
        title: "\u8D28\u68C0\u5355",
        copyNote: "\u7B2C\u4E00\u8054 \u5B58\u6839\uFF08\u5316\u9A8C\u5BA4\u7559\u5B58\uFF09",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          {
            id: uid(),
            kind: "kv",
            // 一个字段区装下三段：小标题「基本信息 / 判定 / 留样」由字段所属分组带出
            fields: [
              "order_no",
              "party_name",
              "sample_no",
              "test_method_label",
              "grade",
              "decision_label",
              "moisture_deduct",
              "impurity_deduct",
              "retention_no",
              "retention_until",
              "is_recheck"
            ]
          },
          { id: uid(), kind: "table", title: "\u8D28\u68C0\u6307\u6807", dataset: "indicators", columns: ["name", "value", "std", "over", "note"] },
          { id: uid(), kind: "text", text: "\u62D2\u6536\u539F\u56E0\uFF1A{{reject_reason}}" },
          { id: uid(), kind: "sign", signers: ["\u5316\u9A8C\u5458\u7B7E\u5B57", "\u53F8\u78C5\u5458\u786E\u8BA4"] }
        ]
      };
    case "settlement_voucher":
      return {
        scenario,
        name: "\u7ED3\u7B97\u51ED\u8BC1\uFF08\u9ED8\u8BA4\uFF09",
        paper: "A4",
        title: "\u7ED3\u7B97\u51ED\u8BC1",
        copyNote: "\u7B2C\u4E00\u8054 \u5B58\u6839\uFF08\u8D22\u52A1\u5165\u8D26\uFF09",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          {
            id: uid(),
            kind: "kv",
            // 一个字段区装下两段：小标题「基本信息 / 金额」由字段所属分组带出
            fields: [
              "payee_name",
              "period",
              "order_count",
              "status_label",
              "total_goods",
              "total_deduction",
              "payable",
              "paid",
              "unpaid",
              "payable_upper",
              "main_method_label"
            ]
          },
          { id: uid(), kind: "table", title: "\u7ED3\u7B97\u78C5\u5355\u660E\u7EC6", dataset: "orders", columns: ["order_no", "settlement_weight", "price", "goods_amount"] },
          // 出厂就出**一维码**，与过磅单那枚凭票码（只出二维码）刻意不同：
          // 这张凭证的归宿是结算窗口的扫码枪，而现场那支多半是几十块的键盘口激光枪，
          // 解不动二维码；挂账的客户把凭证再递回来核销时，扫不出来就得让人手敲单号。
          // 纸型是 A4（210mm 可打 182mm），一条 CODE128 连静区约 60mm，放得下不必压。
          // 老模板没有 codeStyle 字段，缺省仍是 "qr"（见 types.ts）——已经打顺了的站点不受影响。
          { id: uid(), kind: "qr", title: "\u51ED\u5355\u7801\uFF08\u6302\u8D26\u6838\u9500\u65F6\u626B\uFF09", text: "{{settle_code}}", codeStyle: "barcode", qrCaption: true },
          { id: uid(), kind: "sign", signers: ["\u6536\u6B3E\u4EBA\u7B7E\u5B57", "\u51FA\u7EB3", "\u7AD9\u957F"] }
        ]
      };
    case "payment_receipt":
      return {
        scenario,
        name: "\u4ED8\u6B3E\u5C0F\u7968\uFF08\u9ED8\u8BA4\uFF09",
        paper: "thermal80",
        title: "\u4ED8\u6B3E\u51ED\u8BC1",
        copyNote: "\u5BA2\u6237\u8054",
        showReprintBadge: true,
        updatedAt: BASELINE,
        sections: [
          {
            id: uid(),
            kind: "kv",
            // 一个字段区装下三段：小标题「基本信息 / 关联 / 金额」由字段所属分组带出
            fields: [
              "pay_no",
              "paid_at",
              "party_name",
              "method_label",
              "trade_no",
              "voucher_no",
              "settle_no",
              "order_no",
              "amount",
              "amount_upper"
            ]
          },
          { id: uid(), kind: "sign", signers: ["\u6536\u6B3E\u4EBA\u7B7E\u5B57", "\u7ECF\u624B\u4EBA"] }
        ]
      };
    case "ledger":
      return {
        scenario,
        name: "\u6536\u8D2D\u53F0\u8D26\uFF08\u9ED8\u8BA4\uFF09",
        paper: "A4",
        title: "\u6536\u8D2D\u660E\u7EC6\u53F0\u8D26",
        copyNote: "\u62A5\u9001\u7559\u5B58",
        showReprintBadge: false,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "\u6C47\u603B", fields: ["period", "row_count", "sum_net", "sum_settle", "sum_goods", "sum_payable", "sum_paid", "sum_credit"] },
          { id: uid(), kind: "table", title: "\u53F0\u8D26\u660E\u7EC6", dataset: "ledgerRows", columns: ["business_date", "order_no", "party_name", "variety_name", "net", "payable", "paid", "weigher"] }
        ]
      };
    case "daily_report":
      return {
        scenario,
        name: "\u6536\u8D2D\u65E5\u62A5\u8868\uFF08\u9ED8\u8BA4\uFF09",
        paper: "A4",
        title: "\u6536\u8D2D\u65E5\u62A5\u8868",
        copyNote: "\u7AD9\u957F\u7559\u5B58",
        showReprintBadge: false,
        updatedAt: BASELINE,
        sections: [
          { id: uid(), kind: "kv", title: "\u5F53\u65E5\u6C47\u603B", fields: ["date", "orders", "parties", "net", "settle", "goods", "payable", "paid", "credit"] },
          { id: uid(), kind: "table", title: "\u5206\u54C1\u79CD", dataset: "dailyVariety", columns: ["variety_name", "orders", "net", "goods", "payable", "paid", "credit", "manual", "reject"] }
        ]
      };
  }
}
function defaultTemplate(scenario) {
  return withLayout(buildTemplate(scenario));
}
function withCodeCaptions(sections) {
  if (!sections.some((s) => s.kind === "qr" && s.qrCaption === void 0)) return sections;
  return sections.map((s) => s.kind === "qr" && s.qrCaption === void 0 ? { ...s, qrCaption: true } : s);
}
function normalizeTemplate(template) {
  const sections = withCodeCaptions(template.sections);
  const baseline = defaultTemplate(template.scenario).sections;
  const missing = baseline.filter((b) => b.required && !sections.some((s) => s.kind === b.kind && s.required));
  if (missing.length === 0) return sections === template.sections ? template : { ...template, sections };
  const next = [...sections];
  for (const block of missing) {
    const restored = { ...block, id: uid() };
    const anchorInDefault = baseline.slice(0, baseline.indexOf(block)).reverse().find((a) => !a.required);
    const anchorIdx = anchorInDefault ? next.findIndex((s) => s.kind === anchorInDefault.kind && s.title === anchorInDefault.title) : -1;
    if (anchorIdx >= 0) next.splice(anchorIdx + 1, 0, restored);
    else next.push(restored);
  }
  return { ...template, sections: next };
}

// scripts/receipt-code/check.ts
var fails = 0;
function ok(name, cond, extra) {
  if (cond) console.log(`PASS ${name}`);
  else {
    fails++;
    console.log(`FAIL ${name}`, extra === void 0 ? "" : JSON.stringify(extra));
  }
}
var mm1 = (n) => Math.round(n * 10) / 10;
ok("A1 Code B \u8D77\u6B65 + \u5B57\u6BCD\u6570\u5B57\u6DF7\u6392", JSON.stringify(encodeCode128("AB12")) === JSON.stringify([104, 33, 34, 17, 18, 19, 106]), encodeCode128("AB12"));
ok("A2 \u5168\u6570\u5B57\u5076\u6570\u4F4D \u2192 Code C \u8D77\u6B65", JSON.stringify(encodeCode128("1234")) === JSON.stringify([105, 12, 34, 82, 106]), encodeCode128("1234"));
ok("A3 \u4E24\u4F4D\u6570\u636E\u7684\u6821\u9A8C\u7801\u6743\u91CD", JSON.stringify(encodeCode128("BD")) === JSON.stringify([104, 34, 36, 4, 106]), encodeCode128("BD"));
var TICKET = "BH1:BD310120260913000031";
var symbols = encodeCode128(TICKET) ?? [];
ok("A4 \u5355\u53F7\u91CC\u957F\u6570\u5B57\u6BB5\u88AB\u538B\u6210 Code C", symbols.includes(99) && symbols.length < TICKET.length + 4, { n: symbols.length });
ok("A5 \u975E ASCII \u4E00\u5F8B\u62D2\u7F16\uFF08\u5B81\u53EF\u4E0D\u6253\u4E5F\u4E0D\u4E22\u5B57\uFF09", encodeCode128("\u6EE8\u6CB3\u7CAE\u7AD9") === null && code128Runs("\u7968 BH1") === null);
ok("A6 \u7A7A\u4E32\u4E0D\u7F16", encodeCode128("") === null);
var runs = code128Runs(TICKET) ?? [];
ok("B1 \u9996\u5143\u7D20\u662F\u6761\u3001\u672B\u5143\u7D20\u662F\u505C\u6B62\u7B26\u7684\u6761", runs.length > 0 && runs.length % 2 === 1, runs.length);
ok("B2 \u6BCF\u4E2A\u7801\u5B57 6 \u5143\u7D20\u3001\u505C\u6B62\u7B26 7 \u5143\u7D20", (symbols.length - 1) * 6 + 7 === runs.length, { runs: runs.length, symbols: symbols.length });
ok("B3 \u6A21\u5757\u603B\u6570\u542B\u9759\u533A\u540E\u4E0D\u5C0F\u4E8E\u7801\u8EAB", runs.reduce((a, b) => a + b, 0) + CODE128_QUIET_MODULES * 2 > 0);
ok("B4 \u7801\u8868\u6BCF\u4E2A\u7801\u5B57\u6070\u597D 11 \u4E2A\u6A21\u5757\u3001\u505C\u6B62\u7B26 13 \u4E2A", (code128Runs("A") ?? []).reduce((a, b) => a + b, 0) === 46, (code128Runs("A") ?? []).reduce((a, b) => a + b, 0));
ok("C1 2 \u6863 = 0.5mm/\u6A21\u5757\uFF08\u673A\u5668\u51FA\u5382\u503C\uFF09", CODE_SCALE_DOTS[2] * DOT_MM === 0.5);
ok("C2 \u6863\u4F4D\u8868\u5355\u8C03\u9012\u589E", [1, 2, 3, 4, 5].every((s, i) => i === 0 || CODE_SCALE_DOTS[s] > CODE_SCALE_DOTS[[1, 2, 3, 4, 5][i - 1]]));
ok("C3 \u810F\u6863\u4F4D\u56DE\u843D\u5230\u300C\u4E2D\u300D\uFF0C\u7EDD\u4E0D\u653E\u5927", scaleOf(void 0) === 2 && scaleOf(0) === 2 && scaleOf(99) === 2 && scaleOf(5) === 5);
var modules = runs.reduce((a, b) => a + b, 0) + CODE128_QUIET_MODULES * 2;
ok("C4 \u70ED\u654F\u7EB8\u7684\u53EF\u6253\u5BBD\u5EA6\u53D6\u7684\u662F\u673A\u5185\u6805\u683C", printableMm("thermal58") === 48 && printableMm("thermal80") === 64, printableMm("thermal58"));
for (const paper of ["thermal58", "thermal80", "A4", "dot241"]) {
  const max = printableDots(paper);
  for (const scale of [1, 2, 3, 4, 5]) {
    const want = CODE_SCALE_DOTS[scale];
    const got = fitModuleDots(modules, max, want);
    ok(`C5 ${paper}/\u6863${scale} \u653E\u5F97\u4E0B\u6216\u538B\u5230\u6781\u9650`, got <= want && modules * got <= max, { got, w: mm1(modules * got * DOT_MM), max });
  }
}
var bar58 = measureCode128(TICKET, "thermal58", 4);
var barA4 = measureCode128(TICKET, "A4", 2);
ok("C6 58 \u7EB8\u4E0A\u662F\u538B\u8FC7\u7684\u3001A4 \u7528\u51FA\u5382\u6863\u653E\u5F97\u4E0B", !!bar58?.shrunk && barA4?.shrunk === false, { s58: bar58?.dots, sA4: barA4?.dots });
ok("C7 \u6761\u9AD8\u56FA\u5B9A 12mm", BARCODE_HEIGHT_DOTS * DOT_MM === 12);
ok("C8 \u6CA1\u538B\u7684\u65F6\u5019\u70B9\u6570\u5C31\u7B49\u4E8E\u6240\u9009\u6863\u4F4D", !!barA4 && barA4.dots === CODE_SCALE_DOTS[2]);
ok("C9 \u538B\u8FC7\u4E4B\u540E\u4E00\u5B9A\u653E\u5F97\u8FDB\u8FD9\u5F20\u7EB8", ["thermal58", "thermal80", "A4", "dot241"].every((p) => {
  for (const s of [1, 2, 3, 4, 5]) {
    const g = measureCode128(TICKET, p, s);
    if (!g) return false;
    if (g.widthMm > printableMm(p) + DOT_MM) return false;
    if (!g.shrunk && g.dots !== CODE_SCALE_DOTS[s]) return false;
  }
  return true;
}));
var fakeSpec = {
  fields: [
    { key: "a", label: "\u552E\u7CAE\u4EBA", group: "\u552E\u7CAE\u4EBA", kind: "text" },
    { key: "b", label: "\u6BDB\u91CD", group: "\u91CD\u91CF", kind: "weight" },
    { key: "c", label: "\u8EAB\u4EFD", group: "\u552E\u7CAE\u4EBA", kind: "text" }
  ],
  resolveField: (k) => k.toUpperCase()
};
var clusters = kvClusters(fakeSpec, ["a", "b", "c"], {});
ok(
  "D1 \u540C\u7EC4\u4F46\u4E0D\u76F8\u90BB\u7684\u5B57\u6BB5\u4E0D\u518D\u88AB\u5408\u5E76\u56DE\u9996\u6BB5",
  clusters.map((cl) => cl.rows.map((r) => r.key).join("")).join("|") === "a|b|c",
  clusters.map((cl) => cl.group + ":" + cl.rows.map((r) => r.key).join(","))
);
ok("D2 \u76F8\u90BB\u540C\u5B57\u6BB5\u4ECD\u5408\u6210\u4E00\u6BB5", kvClusters(fakeSpec, ["b", "b"], {}).length === 1);
ok("D3 \u7968\u9762\u884C\u5E8F\u9010\u5B57\u7B49\u4E8E fields \u987A\u5E8F", kvClusters(fakeSpec, ["c", "a", "b"], {}).flatMap((cl) => cl.rows.map((r) => r.key)).join("") === "cab");
var tpl = defaultTemplate("weigh_order");
var ctx = SCENARIOS.weigh_order.sampleContext();
var codeSec = tpl.sections.find((s) => s.kind === "qr");
var lines = receiptLines({ ...tpl, sections: tpl.sections.map((s) => s === codeSec ? { ...s, codeStyle: "both" } : s) }, ctx);
var qrLine = lines.find((l) => l.kind === "qr");
var barLine = lines.find((l) => l.kind === "barcode");
ok("E1 \u4E24\u79CD\u7801\u90FD\u53D1\uFF0C\u4E14\u8F7D\u8377\u5C31\u662F\u5355\u53F7\u5951\u7EA6\u90A3\u4E00\u4E32", !!qrLine?.text.startsWith("BH1:") && !!barLine && barLine.runs.length > 0, { qr: qrLine?.text });
ok("E2 \u5C3A\u5BF8\u6863\u4F4D\u771F\u7684\u53D1\u5230\u4E86\u673A\u5668\u4E0A", qrLine?.size === CODE_SCALE_DOTS[scaleOf(codeSec.qrScale)] && barLine?.dots === CODE_SCALE_DOTS[scaleOf(codeSec.qrScale)], { size: qrLine?.size, dots: barLine?.dots });
ok("E3 \u6761\u9AD8\u4E0E\u9884\u89C8\u540C\u4E00\u5E38\u6570", barLine?.height === BARCODE_HEIGHT_DOTS);
var legacy = receiptLines(tpl, ctx).filter((l) => l.kind === "barcode");
ok("E4 \u6CA1\u52A8\u8FC7\u7801\u5236\u7684\u8001\u6A21\u677F\u53EA\u53D1\u4E8C\u7EF4\u7801\uFF08\u4E00\u7EF4\u7801\u4E0D\u65E0\u4E2D\u751F\u6709\uFF09", legacy.length === 0);
var settleTpl = defaultTemplate("settlement_voucher");
var settleCode = settleTpl.sections.find((s) => s.kind === "qr");
ok("F1 \u7ED3\u7B97\u51ED\u8BC1\u51FA\u5382\u90A3\u679A\u51ED\u5355\u7801\u662F\u4EC5\u4E00\u7EF4\u6761\u7801", settleCode.codeStyle === "barcode", settleCode.codeStyle);
var settleCtx = SCENARIOS.settlement_voucher.sampleContext();
var settleTx = receiptLines(settleTpl, settleCtx);
ok(
  "F2 \u7ED3\u7B97\u51ED\u8BC1\u53D1\u5230\u673A\u5668\u4E0A\u7684\u662F\u6761\u7801\u3001\u4E14\u4E0D\u53D1\u4E8C\u7EF4\u7801",
  !settleTx.some((l) => l.kind === "qr") && settleTx.some((l) => l.kind === "barcode"),
  settleTx.filter((l) => l.kind === "qr" || l.kind === "barcode").map((l) => l.kind)
);
var settleBar = settleTx.find((l) => l.kind === "barcode");
ok("F3 \u7ED3\u7B97\u51ED\u8BC1\u7684\u6761\u7801\u5728 A4 \u4E0A\u4E0D\u5FC5\u538B\u7F29\u3001\u6761\u9AD8\u56FA\u5B9A", settleBar?.dots === CODE_SCALE_DOTS[2] && settleBar?.height === BARCODE_HEIGHT_DOTS, { dots: settleBar?.dots });
ok("F4 \u8FC7\u78C5\u5355\u51FA\u5382\u90A3\u679A\u51ED\u7968\u7801\u4ECD\u662F\u4E8C\u7EF4\u7801\uFF08\u4E0D\u88AB\u987A\u624B\u6539\u6389\uFF09", (codeSec.codeStyle ?? "qr") === "qr", codeSec.codeStyle);
var ALL_SCENARIOS = Object.keys(SCENARIOS);
var defaultCodes = ALL_SCENARIOS.flatMap((s) => defaultTemplate(s).sections).filter((b) => b.kind === "qr");
ok(
  "G1 \u51FA\u5382\u5E26\u7801\u7684\u7968\u636E\u4E00\u5F8B\u663E\u5F0F\u300C\u5370\u5185\u5BB9\u300D",
  defaultCodes.length > 0 && defaultCodes.every((b) => b.qrCaption === true),
  defaultCodes.map((b) => b.qrCaption)
);
var stripCaption = (t) => ({ ...t, sections: t.sections.map((s) => s.kind === "qr" ? { ...s, qrCaption: void 0 } : s) });
var legacy2 = normalizeTemplate(stripCaption(tpl));
ok(
  "G2 \u6CA1\u5199\u8FC7\u8FD9\u4E2A\u5B57\u6BB5\u7684\u8001\u6A21\u677F\uFF0C\u53D6\u7528\u65F6\u8865\u6210\u300C\u5370\u300D",
  legacy2.sections.filter((s) => s.kind === "qr").every((s) => s.qrCaption === true),
  legacy2.sections.filter((s) => s.kind === "qr").map((s) => s.qrCaption)
);
ok(
  "G3 \u7528\u6237\u660E\u786E\u5173\u8FC7\u7684\u4E0D\u88AB\u515C\u5E95\u6539\u56DE\u6765",
  normalizeTemplate({ ...tpl, sections: tpl.sections.map((s) => s.kind === "qr" ? { ...s, qrCaption: false } : s) }).sections.filter((s) => s.kind === "qr").every((s) => s.qrCaption === false)
);
ok("G4 \u65E0\u9700\u515C\u5E95\u65F6\u8FD4\u56DE\u539F\u5BF9\u8C61\uFF08\u5F15\u7528\u4E0D\u53D8\uFF09", normalizeTemplate(tpl) === tpl);
var capTx = receiptLines(tpl, ctx);
var capQr = capTx.find((l) => l.kind === "qr");
var capLine = capTx[capTx.findIndex((l) => l.kind === "qr") + 1];
ok(
  "G5 \u70ED\u654F\uFF1A\u7801\u4E4B\u540E\u7D27\u63A5\u4E00\u884C\u5C45\u4E2D\u6587\u672C\uFF0C\u5185\u5BB9\u5C31\u662F\u7801\u7684\u8F7D\u8377",
  capLine?.kind === "text" && capLine.text === capQr?.text && capLine.align === "center",
  capLine
);
var settleCap = settleTx[settleTx.findIndex((l) => l.kind === "barcode") + 1];
var settlePayload = String(SCENARIOS.settlement_voucher.resolveField("settle_code", settleCtx));
ok(
  "G6 \u70ED\u654F\uFF1A\u4EC5\u6761\u7801\u7684\u51ED\u8BC1\u4E5F\u5728\u6761\u7801\u4E0B\u65B9\u5370\u51FA\u5185\u5BB9",
  settleCap?.kind === "text" && settleCap.text === settlePayload && settleCap.align === "center",
  { got: settleCap, want: settlePayload }
);
ok(
  "G7 \u5173\u6389\u4E4B\u540E\u7EB8\u4E0A\u771F\u7684\u5C11\u8FD9\u4E00\u884C",
  !receiptLines({ ...tpl, sections: tpl.sections.map((s) => s.kind === "qr" ? { ...s, qrCaption: false } : s) }, ctx).some(
    (l) => l.kind === "text" && l.text === capQr?.text
  )
);
var FULL58 = 464;
var hBar = measureCode128(TICKET, "thermal58", 4);
var hBw = (hBar?.modules ?? 0) * (hBar?.dots ?? 0);
ok("H1 80 \u673A 80 \u7EB8\uFF1A\u843D\u70B9\u5C31\u662F\u56FA\u4EF6\u539F\u6765\u90A3\u4E2A\uFF08\u6309\u5934\u5BBD\u5C45\u4E2D\uFF09", codeOffsetDots(hBw, "thermal80", "thermal80") === Math.round((576 - hBw) / 2), codeOffsetDots(hBw, "thermal80", "thermal80"));
ok("H2 58 \u673A 58 \u7EB8\uFF1A\u540C\u6837\u5206\u6BEB\u4E0D\u52A8", codeOffsetDots(hBw, "thermal58", "thermal58") === Math.round((384 - hBw) / 2));
var hPad = codeOffsetDots(hBw, "thermal58", "thermal80");
ok("H3 80 \u673A\u88C5 58 \u5377\uFF1A\u6574\u6761\u7801\u843D\u5728\u7EB8\u5185", hPad + hBw <= FULL58, { pad: hPad, bw: hBw, full: FULL58 });
ok("H4 \u4E14\u662F\u5728\u5377\u4E0A\u5C45\u4E2D\uFF08\u5DE6\u53F3\u7559\u767D\u76F8\u7B49\uFF09", Math.abs(FULL58 - hBw - 2 * hPad) <= 1, { pad: hPad, bw: hBw });
var oldRight = (w) => Math.round((576 - w) / 2) + w;
ok(
  "H5 \u56DE\u5F52\u951A\uFF1A\u6539\u524D\u7684\u4F4D\u7F6E\u5728 44mm \u4EE5\u4E0A\u5FC5\u7136\u51FA\u7EB8\uFF0848mm \u90A3\u6863\u6B63\u662F\u88AB\u5207\u7684\u90A3\u4E00\u6863\uFF09",
  oldRight(384) > FULL58 && oldRight(352) <= FULL58,
  { w384: oldRight(384), w352: oldRight(352), full: FULL58 }
);
var hBar80 = measureCode128(TICKET, "thermal80", 2, codeBudgetDots("thermal80", "thermal58"));
ok("H6 \u7968\u9762 80 \u88C5 58 \u673A\uFF1A\u5BBD\u5EA6\u9884\u7B97\u88AB\u673A\u5934\u538B\u5230 384 \u70B9", !!hBar80 && hBar80.modules * hBar80.dots <= 384, hBar80 && hBar80.modules * hBar80.dots);
ok("H7 \u4E00\u81F4\u88C5\u6001\u7684\u9884\u7B97\u4E0D\u53D8\uFF0880/512\u300158/384\uFF09", codeBudgetDots("thermal80", "thermal80") === 512 && codeBudgetDots("thermal58", "thermal58") === 384);
var hQrDots = qrSideDots(TICKET, 2) ?? 0;
var hMid = (w) => codeOffsetDots(w, "thermal58", "thermal80") + w / 2;
ok("H8 \u4E8C\u7EF4\u7801\u4E0E\u6761\u7801\u540C\u8F74\uFF08\u4E2D\u7EBF\u76F8\u5DEE\u4E0D\u8D85\u8FC7 1 \u70B9\uFF09", Math.abs(hMid(hBw) - hMid(hQrDots)) <= 1, { bar: hMid(hBw), qr: hMid(hQrDots) });
ok("H9 \u5B9A\u957F\u7EB8\u7684\u843D\u70B9\u6052\u4E3A 0", codeOffsetDots(400, "A4") === 0 && codeOffsetDots(400, "dot241") === 0);
var t58Tpl = { ...settleTpl, paper: "thermal58" };
var t58Lines = receiptLines(t58Tpl, settleCtx, { machinePaper: "thermal80" });
var t58Bar = t58Lines.find((l) => l.kind === "barcode");
ok(
  "H10 58 \u5377 + 80 \u673A\u51FA\u7968\uFF1A\u6761\u7801\u6574\u6761\u843D\u5728\u7EB8\u5185\uFF08\u843D\u70B9\u771F\u7684\u6302\u5230\u4E86\u884C\u4E0A\uFF09",
  !!t58Bar && (t58Bar.padLeft ?? 0) + t58Bar.runs.reduce((a, b) => a + b, 0) * t58Bar.dots <= FULL58,
  t58Bar && { pad: t58Bar.padLeft, bw: t58Bar.runs.reduce((a, b) => a + b, 0) * t58Bar.dots }
);
ok(
  "H11 \u540C\u4E00\u5F20\u7968\u6392\u7ED9 80 \u7EB8\u65F6\uFF0C\u843D\u70B9\u6309 80 \u7B97\uFF08\u4E0D\u662F\u6284\u4E0A\u4E00\u5F20\u7EB8\u7684\u6570\uFF09",
  (() => {
    const bar = receiptLines({ ...settleTpl, paper: "thermal80" }, settleCtx, { machinePaper: "thermal80" }).find((l) => l.kind === "barcode");
    const w = bar ? bar.runs.reduce((a, b) => a + b, 0) * bar.dots : 0;
    return !!bar && w + (bar.padLeft ?? 0) <= 576;
  })()
);
ok("H12 A4 / \u9488\u5F0F\u90A3\u4E00\u4FA7\u4E0D\u5E26\u843D\u70B9\uFF08\u843D\u70B9\u5F52\u9A71\u52A8\uFF09", receiptLines(settleTpl, settleCtx).every((l) => l.kind === "barcode" || l.kind === "qr" ? (l.padLeft ?? 0) === 0 : true));
console.log(fails === 0 ? "\n\u5168\u90E8\u901A\u8FC7" : `
${fails} \u6761\u4E0D\u901A\u8FC7`);
process.exit(fails === 0 ? 0 : 1);
/*! Bundled license information:

react/cjs/react.production.js:
  (**
   * @license React
   * react.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react.development.js:
  (**
   * @license React
   * react.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.production.js:
  (**
   * @license React
   * react-jsx-runtime.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.development.js:
  (**
   * @license React
   * react-jsx-runtime.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
