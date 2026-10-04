/* WebRTC transport for the browser socket adapter.

   The public API is window.HaloWebTransport.  Signalling is deliberately
   supplied by the page: this module owns peer connections and DataChannels,
   but does not know whether offers travel through a Worker, a local test
   harness, or another signalling service. */

addToLibrary({
  $HaloWebTransportRuntime__postset: 'HaloWebTransportRuntime.install();',
  $HaloWebTransportRuntime: {
    RELIABLE_LABEL: 'halo-reliable-v1',
    UNRELIABLE_LABEL: 'halo-unreliable-v1',
    RELIABLE_HIGH_WATER: 1024 * 1024,
    UNRELIABLE_HIGH_WATER: 256 * 1024,
    RELIABLE_QUEUE_LIMIT: 4 * 1024 * 1024,
    UNRELIABLE_QUEUE_LIMIT: 512 * 1024,
    UNRELIABLE_PACKET_LIMIT: 256,
    REMOTE_CANDIDATE_LIMIT: 64,
    peersById: new Map(),
    peersByAddress: new Map(),
    registrationChain: null,
    options: {
      iceServers: [],
      onSignal: null,
      onStateChange: null,
      onError: null,
    },
    pumpTimer: 0,
    pumping: false,

    normalizeAddress: function(address) {
      return address >>> 0;
    },

    addressText: function(address) {
      address = address >>> 0;
      return [address & 255, (address >>> 8) & 255,
        (address >>> 16) & 255, (address >>> 24) & 255].join('.');
    },

    identifierBytes: function(value) {
      if (value instanceof Uint8Array && value.length === 6) {
        return new Uint8Array(value);
      }
      if (typeof value !== 'string' || !/^[0-9a-fA-F]{12}$/.test(value)) {
        throw new TypeError('remoteIdentifier must be 12 hexadecimal characters');
      }
      var bytes = new Uint8Array(6);
      for (var index = 0; index < bytes.length; index++) {
        bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    },

    identifierText: function(bytes) {
      var text = '';
      for (var index = 0; index < bytes.length; index++) {
        text += bytes[index].toString(16).padStart(2, '0');
      }
      return text;
    },

    moduleFunction: function(name) {
      var fn = Module['_' + name];
      if (typeof fn !== 'function') {
        throw new Error('Halo WebAssembly networking is not ready');
      }
      return fn;
    },

    localIdentifier: function() {
      var pointer = HaloWebTransportRuntime.moduleFunction(
        'web_net_remote_local_identifier')();
      return HaloWebTransportRuntime.identifierText(
        HEAPU8.slice(pointer, pointer + 6));
    },

    callWhenUnlocked: async function(fn, timeoutMilliseconds) {
      var deadline = performance.now() + (timeoutMilliseconds || 5000);
      for (;;) {
        var result = fn();
        if (result) return result;
        if (performance.now() >= deadline) {
          throw new Error('Halo networking stayed busy for too long');
        }
        await new Promise(function(resolve) { setTimeout(resolve, 1); });
      }
    },

    registerPeer: async function(identifier) {
      var runtime = HaloWebTransportRuntime;
      if (!runtime.registrationChain ||
          typeof runtime.registrationChain.then !== 'function') {
        runtime.registrationChain = Promise.resolve();
      }
      var operation = runtime.registrationChain.then(function() {
        var ingress = runtime.moduleFunction('web_net_remote_ingress_buffer')();
        HEAPU8.set(identifier, ingress);
        return runtime.callWhenUnlocked(function() {
          return runtime.moduleFunction('web_net_remote_add_peer')(
            ingress, identifier.length) >>> 0;
        });
      });
      runtime.registrationChain = operation.catch(function() {});
      return operation;
    },

    removePeerFromWasm: async function(address) {
      var runtime = HaloWebTransportRuntime;
      if (!runtime.registrationChain ||
          typeof runtime.registrationChain.then !== 'function') {
        runtime.registrationChain = Promise.resolve();
      }
      var operation = runtime.registrationChain.then(function() {
        return runtime.callWhenUnlocked(function() {
          return runtime.moduleFunction('web_net_remote_remove_peer')(address);
        });
      });
      runtime.registrationChain = operation.catch(function() {});
      try {
        await operation;
      } catch (error) {
        runtime.reportError(null, error);
      }
    },

    reportError: function(record, error) {
      var callback = HaloWebTransportRuntime.options.onError;
      if (typeof callback === 'function') {
        try {
          callback({
            peerId: record ? record.peerId : null,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        } catch (callbackError) {
          console.error('Halo WebRTC error callback failed', callbackError);
        }
      } else {
        console.error('Halo WebRTC transport', error);
      }
    },

    emitState: function(record, state, detail) {
      if (record.lastPublicState === state && !detail) return;
      record.lastPublicState = state;
      var callback = HaloWebTransportRuntime.options.onStateChange;
      if (typeof callback === 'function') {
        try {
          callback({
            peerId: record.peerId,
            state: state,
            detail: detail || null,
            address: record.addressText,
          });
        } catch (error) {
          HaloWebTransportRuntime.reportError(record, error);
        }
      }
    },

    emitSignal: function(record, signal) {
      var callback = HaloWebTransportRuntime.options.onSignal;
      if (typeof callback !== 'function') {
        HaloWebTransportRuntime.reportError(record,
          new Error('No WebRTC signalling callback is configured'));
        return;
      }
      Promise.resolve().then(function() {
        if (record.removed) return;
        return callback({ peerId: record.peerId, signal: signal });
      }).catch(function(error) {
        HaloWebTransportRuntime.reportError(record, error);
      });
    },

    channelWriteable: function(channel, highWater) {
      return !!channel && channel.readyState === 'open' &&
        channel.bufferedAmount <= highWater;
    },

    channelsReady: function(record) {
      return !!record.reliable && record.reliable.readyState === 'open' &&
        !!record.unreliable && record.unreliable.readyState === 'open';
    },

    schedulePump: function(delay) {
      var runtime = HaloWebTransportRuntime;
      if (runtime.pumpTimer) return;
      runtime.pumpTimer = setTimeout(function() {
        runtime.pumpTimer = 0;
        runtime.pump();
      }, delay || 0);
    },

    syncPeerState: function(record) {
      if (!record || record.removed) return;
      var runtime = HaloWebTransportRuntime;
      var connected = runtime.channelsReady(record);
      var reliableWriteable = connected && runtime.channelWriteable(
        record.reliable, runtime.RELIABLE_HIGH_WATER);
      var unreliableWriteable = connected && runtime.channelWriteable(
        record.unreliable, runtime.UNRELIABLE_HIGH_WATER);
      var result;
      try {
        result = runtime.moduleFunction('web_net_remote_set_peer_state')(
          record.address, connected ? 1 : 0,
          reliableWriteable ? 1 : 0, unreliableWriteable ? 1 : 0);
      } catch (error) {
        runtime.reportError(record, error);
        return;
      }
      if (result === 0) {
        record.needsStateSync = true;
        runtime.schedulePump(1);
        return;
      }
      record.needsStateSync = false;
      if (result < 0) return;
      if (connected) runtime.emitState(record, 'connected');
    },

    configureChannel: function(record, channel, reliable) {
      var runtime = HaloWebTransportRuntime;
      var expected = reliable ? runtime.RELIABLE_LABEL : runtime.UNRELIABLE_LABEL;
      if (channel.label !== expected) {
        channel.close();
        runtime.failPeer(record, new Error('Unexpected DataChannel: ' + channel.label));
        return;
      }
      if ((reliable && (!channel.ordered || channel.maxRetransmits !== null)) ||
          (!reliable && (channel.ordered || channel.maxRetransmits !== 0))) {
        channel.close();
        runtime.failPeer(record, new Error('Peer offered incompatible DataChannel settings'));
        return;
      }
      if ((reliable && record.reliable) || (!reliable && record.unreliable)) {
        channel.close();
        runtime.failPeer(record, new Error('Peer opened a duplicate DataChannel'));
        return;
      }
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = reliable ?
        runtime.RELIABLE_HIGH_WATER / 2 : runtime.UNRELIABLE_HIGH_WATER / 2;
      if (reliable) record.reliable = channel;
      else record.unreliable = channel;
      channel.onopen = function() {
        record.needsStateSync = true;
        runtime.syncPeerState(record);
        runtime.schedulePump(0);
      };
      channel.onclose = function() {
        if (!record.removed) {
          runtime.failPeer(record, new Error(
            (reliable ? 'Reliable' : 'Unreliable') + ' DataChannel closed'));
        }
      };
      channel.onerror = function(event) {
        runtime.reportError(record, new Error(
          (reliable ? 'Reliable' : 'Unreliable') + ' DataChannel failed'));
      };
      channel.onbufferedamountlow = function() {
        record.needsStateSync = true;
        runtime.syncPeerState(record);
      };
      channel.onmessage = function(event) {
        runtime.receiveChannelMessage(record, reliable, event.data);
      };
      if (channel.readyState === 'open') {
        record.needsStateSync = true;
        runtime.syncPeerState(record);
      }
    },

    receiveChannelMessage: function(record, reliable, value) {
      var runtime = HaloWebTransportRuntime;
      if (record.removed) return;
      if (!(value instanceof ArrayBuffer)) {
        runtime.failPeer(record, new Error('DataChannel sent a non-binary message'));
        return;
      }
      var bytes = new Uint8Array(value);
      if (bytes.byteLength < 12 || bytes.byteLength > 16396) {
        runtime.failPeer(record, new Error('DataChannel frame has an invalid size'));
        return;
      }
      if (reliable) {
        if (record.reliableQueuedBytes + bytes.byteLength > runtime.RELIABLE_QUEUE_LIMIT) {
          runtime.failPeer(record, new Error('Reliable receive queue overflow'));
          return;
        }
        record.reliableQueue.push(bytes);
        record.reliableQueuedBytes += bytes.byteLength;
      } else {
        if (record.unreliableQueue.length >= runtime.UNRELIABLE_PACKET_LIMIT ||
            record.unreliableQueuedBytes + bytes.byteLength > runtime.UNRELIABLE_QUEUE_LIMIT) {
          /* UDP is best effort: discard the newest update when the game is
             not keeping up, rather than adding input latency. */
          record.droppedDatagrams++;
          return;
        }
        record.unreliableQueue.push(bytes);
        record.unreliableQueuedBytes += bytes.byteLength;
      }
      runtime.schedulePump(0);
    },

    deliverOne: function(record, reliable) {
      var runtime = HaloWebTransportRuntime;
      var queue = reliable ? record.reliableQueue : record.unreliableQueue;
      if (!queue.length || !runtime.channelsReady(record)) return 1;
      var bytes = queue[0];
      var ingress = runtime.moduleFunction('web_net_remote_ingress_buffer')();
      var capacity = runtime.moduleFunction('web_net_remote_ingress_capacity')();
      if (bytes.byteLength > capacity) return -1;
      HEAPU8.set(bytes, ingress);
      var result = runtime.moduleFunction('web_net_remote_receive')(
        record.address, bytes.byteLength);
      if (result > 0) {
        queue.shift();
        if (reliable) record.reliableQueuedBytes -= bytes.byteLength;
        else record.unreliableQueuedBytes -= bytes.byteLength;
      }
      return result;
    },

    pump: function() {
      var runtime = HaloWebTransportRuntime;
      if (runtime.pumping) return;
      runtime.pumping = true;
      var retry = false;
      try {
        runtime.peersById.forEach(function(record) {
          if (record.removed) return;
          if (record.needsStateSync) runtime.syncPeerState(record);
          var reliableResult = runtime.deliverOne(record, true);
          if (reliableResult < 0) {
            runtime.failPeer(record, new Error('Malformed reliable transport frame'));
            return;
          }
          if (reliableResult === 0) retry = true;
          /* Bound work per task so packet bursts do not monopolize the UI. */
          for (var index = 0; index < 16 && record.unreliableQueue.length; index++) {
            var unreliableResult = runtime.deliverOne(record, false);
            if (unreliableResult < 0) {
              runtime.failPeer(record, new Error('Malformed unreliable transport frame'));
              return;
            }
            if (unreliableResult === 0) {
              retry = true;
              break;
            }
          }
          if (record.needsStateSync ||
              (runtime.channelsReady(record) &&
               (record.reliableQueue.length || record.unreliableQueue.length))) retry = true;
        });
      } finally {
        runtime.pumping = false;
      }
      if (retry) runtime.schedulePump(1);
    },

    makeOffer: async function(record, iceRestart) {
      if (record.removed || record.makingOffer) return;
      record.makingOffer = true;
      try {
        if (iceRestart) {
          record.pc.restartIce();
        }
        await record.pc.setLocalDescription();
        if (record.removed) return;
        HaloWebTransportRuntime.emitSignal(record, {
          description: record.pc.localDescription.toJSON(),
        });
      } catch (error) {
        HaloWebTransportRuntime.failPeer(record, error);
      } finally {
        record.makingOffer = false;
      }
    },

    failPeer: function(record, error) {
      if (!record || record.removed) return;
      HaloWebTransportRuntime.reportError(record, error);
      HaloWebTransportRuntime.emitState(record, 'failed', error.message || String(error));
      HaloWebTransportRuntime.removePeer(record.peerId);
    },

    addPeer: async function(options) {
      var runtime = HaloWebTransportRuntime;
      if (!options || typeof options.peerId !== 'string' || !options.peerId ||
          options.peerId.length > 128) {
        throw new TypeError('peerId must be a non-empty string of at most 128 characters');
      }
      if (runtime.peersById.has(options.peerId)) {
        throw new Error('Peer already exists: ' + options.peerId);
      }
      var identifier = runtime.identifierBytes(options.remoteIdentifier);
      if (runtime.identifierText(identifier) === runtime.localIdentifier()) {
        throw new Error('Cannot connect this browser to itself');
      }
      var address = await runtime.registerPeer(identifier);
      if (!address) throw new Error('No virtual peer addresses are available');
      if (runtime.peersByAddress.has(address)) {
        throw new Error('A virtual peer address is already in use');
      }
      var configuration = {
        iceServers: options.iceServers || runtime.options.iceServers || [],
        bundlePolicy: 'max-bundle',
      };
      var pc = new RTCPeerConnection(configuration);
      var record = {
        peerId: options.peerId,
        identifier: runtime.identifierText(identifier),
        address: address,
        addressText: runtime.addressText(address),
        pc: pc,
        polite: options.polite !== undefined ? !!options.polite : !options.initiator,
        makingOffer: false,
        ignoreOffer: false,
        settingRemoteAnswer: false,
        pendingCandidates: [],
        remoteCandidateCount: 0,
        reliable: null,
        unreliable: null,
        reliableQueue: [],
        unreliableQueue: [],
        reliableQueuedBytes: 0,
        unreliableQueuedBytes: 0,
        droppedDatagrams: 0,
        needsStateSync: true,
        lastPublicState: null,
        removed: false,
      };
      runtime.peersById.set(record.peerId, record);
      runtime.peersByAddress.set(record.address, record);
      pc.onicecandidate = function(event) {
        if (event.candidate) {
          runtime.emitSignal(record, { candidate: event.candidate.toJSON() });
        }
      };
      pc.onicecandidateerror = function(event) {
        runtime.reportError(record, new Error('ICE candidate failed: ' +
          (event.errorText || event.errorCode || 'unknown error')));
      };
      pc.onconnectionstatechange = function() {
        var state = pc.connectionState;
        if (state === 'failed') {
          runtime.failPeer(record, new Error('WebRTC connection failed'));
        } else if (state === 'closed') {
          runtime.emitState(record, 'disconnected');
        } else if (state === 'connecting' || state === 'new') {
          runtime.emitState(record, 'connecting');
        }
      };
      pc.ondatachannel = function(event) {
        if (event.channel.label === runtime.RELIABLE_LABEL) {
          runtime.configureChannel(record, event.channel, true);
        } else if (event.channel.label === runtime.UNRELIABLE_LABEL) {
          runtime.configureChannel(record, event.channel, false);
        } else {
          event.channel.close();
        }
      };
      pc.onnegotiationneeded = function() { runtime.makeOffer(record, false); };
      if (options.initiator) {
        runtime.configureChannel(record, pc.createDataChannel(runtime.RELIABLE_LABEL, {
          ordered: true,
        }), true);
        runtime.configureChannel(record, pc.createDataChannel(runtime.UNRELIABLE_LABEL, {
          ordered: false,
          maxRetransmits: 0,
        }), false);
      }
      runtime.emitState(record, 'connecting');
      return {
        peerId: record.peerId,
        address: record.addressText,
        remoteIdentifier: record.identifier,
      };
    },

    handleSignal: async function(peerId, signal) {
      var runtime = HaloWebTransportRuntime;
      var record = runtime.peersById.get(peerId);
      if (!record || record.removed) throw new Error('Unknown peer: ' + peerId);
      if (!signal || (signal.description === undefined && signal.candidate === undefined)) {
        throw new TypeError('Signal must contain a description or candidate');
      }
      if (signal.description) {
        var description = signal.description;
        if (description.type !== 'offer' && description.type !== 'answer') {
          throw new TypeError('Unsupported session description type');
        }
        var readyForOffer = !record.makingOffer &&
          (record.pc.signalingState === 'stable' || record.settingRemoteAnswer);
        var offerCollision = description.type === 'offer' && !readyForOffer;
        record.ignoreOffer = !record.polite && offerCollision;
        if (record.ignoreOffer) return;
        record.settingRemoteAnswer = description.type === 'answer';
        try {
          if (offerCollision) {
            await record.pc.setLocalDescription({ type: 'rollback' });
          }
          await record.pc.setRemoteDescription(description);
          record.settingRemoteAnswer = false;
          while (record.pendingCandidates.length) {
            await record.pc.addIceCandidate(record.pendingCandidates.shift());
          }
          if (description.type === 'offer') {
            await record.pc.setLocalDescription();
            runtime.emitSignal(record, {
              description: record.pc.localDescription.toJSON(),
            });
          }
        } catch (error) {
          record.settingRemoteAnswer = false;
          runtime.failPeer(record, error);
          throw error;
        }
      }
      if (signal.candidate) {
        try {
          record.remoteCandidateCount++;
          if (record.remoteCandidateCount > runtime.REMOTE_CANDIDATE_LIMIT) {
            throw new Error('Peer sent too many ICE candidates');
          }
          if (record.pc.remoteDescription) {
            await record.pc.addIceCandidate(signal.candidate);
          } else {
            record.pendingCandidates.push(signal.candidate);
          }
        } catch (error) {
          if (!record.ignoreOffer) throw error;
        }
      }
    },

    restartIce: async function(peerId) {
      var record = HaloWebTransportRuntime.peersById.get(peerId);
      if (!record || record.removed) throw new Error('Unknown peer: ' + peerId);
      await HaloWebTransportRuntime.makeOffer(record, true);
    },

    removePeer: function(peerId) {
      var runtime = HaloWebTransportRuntime;
      var record = runtime.peersById.get(peerId);
      if (!record || record.removed) return false;
      record.removed = true;
      if (record.reliable) record.reliable.close();
      if (record.unreliable) record.unreliable.close();
      record.pc.close();
      runtime.peersById.delete(peerId);
      if (runtime.peersByAddress.get(record.address) === record) {
        runtime.peersByAddress.delete(record.address);
        runtime.removePeerFromWasm(record.address);
      }
      runtime.emitState(record, 'disconnected');
      return true;
    },

    send: function(address, reliable, pointer, length) {
      var runtime = HaloWebTransportRuntime;
      var record = runtime.peersByAddress.get(runtime.normalizeAddress(address));
      if (!record || record.removed || length < 12 || length > 16396) return 0;
      var channel = reliable ? record.reliable : record.unreliable;
      var highWater = reliable ? runtime.RELIABLE_HIGH_WATER :
        runtime.UNRELIABLE_HIGH_WATER;
      if (!runtime.channelWriteable(channel, highWater)) {
        record.needsStateSync = true;
        runtime.schedulePump(1);
        return 0;
      }
      try {
        var frame = HEAPU8.slice(pointer, pointer + length);
        channel.send(frame);
        if (channel.bufferedAmount > highWater) {
          record.needsStateSync = true;
          runtime.schedulePump(1);
        }
        return 1;
      } catch (error) {
        runtime.reportError(record, error);
        record.needsStateSync = true;
        runtime.schedulePump(1);
        return 0;
      }
    },

    install: function() {
      if (typeof window === 'undefined' || window.HaloWebTransport) return;
      var runtime = HaloWebTransportRuntime;
      window.HaloWebTransport = Object.freeze({
        configure: function(options) {
          options = options || {};
          if (options.iceServers !== undefined) runtime.options.iceServers = options.iceServers;
          if (options.onSignal !== undefined) runtime.options.onSignal = options.onSignal;
          if (options.onStateChange !== undefined) runtime.options.onStateChange = options.onStateChange;
          if (options.onError !== undefined) runtime.options.onError = options.onError;
        },
        getLocalIdentifier: function() { return runtime.localIdentifier(); },
        addPeer: function(options) { return runtime.addPeer(options); },
        handleSignal: function(peerId, signal) { return runtime.handleSignal(peerId, signal); },
        restartIce: function(peerId) { return runtime.restartIce(peerId); },
        removePeer: function(peerId) { return runtime.removePeer(peerId); },
        disconnectAll: function() {
          Array.from(runtime.peersById.keys()).forEach(function(peerId) {
            runtime.removePeer(peerId);
          });
        },
        listPeers: function() {
          return Array.from(runtime.peersById.values()).map(function(record) {
            return {
              peerId: record.peerId,
              address: record.addressText,
              state: record.lastPublicState,
              droppedDatagrams: record.droppedDatagrams,
            };
          });
        },
        getStats: async function(peerId) {
          var record = runtime.peersById.get(peerId);
          if (!record || record.removed) throw new Error('Unknown peer: ' + peerId);
          return record.pc.getStats();
        },
        isSupported: function() { return typeof RTCPeerConnection === 'function'; },
      });
    },
  },

  web_transport_send__deps: ['$HaloWebTransportRuntime'],
  web_transport_send__proxy: 'sync',
  web_transport_send__sig: 'iiiii',
  web_transport_send: function(address, reliable, buffer, length) {
    return HaloWebTransportRuntime.send(address, reliable, buffer, length);
  },
});
