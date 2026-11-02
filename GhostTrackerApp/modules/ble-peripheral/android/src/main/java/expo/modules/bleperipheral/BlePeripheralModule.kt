package expo.modules.bleperipheral

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayDeque
import java.util.UUID

/**
 * BLE Peripheral role for EquiStride sync (thesis §3.7.1).
 *
 * react-native-ble-plx only implements the Central role, so this module adds
 * the other half: a GATT server with one service and two characteristics,
 * plus advertising.
 *
 *   write characteristic   peers (Centrals) write gossip chunks to us
 *   notify characteristic  we push gossip chunks back to subscribed peers
 *
 * The advertisement carries the service UUID; the scan response carries an
 * 8-byte node tag (manufacturer data, test company ID 0xFFFF) so a scanner
 * can tell which phone it found before connecting.
 *
 * Values cross the JS bridge as base64 strings. Android allows one
 * outstanding notification per connection, so notifications are queued per
 * device and the next one is sent from onNotificationSent.
 */
@SuppressLint("MissingPermission") // JS requests BLUETOOTH_ADVERTISE / BLUETOOTH_CONNECT before start()
class BlePeripheralModule : Module() {
  private var gattServer: BluetoothGattServer? = null
  private var notifyCharacteristic: BluetoothGattCharacteristic? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var writeUuid: UUID? = null

  private val devices = mutableMapOf<String, BluetoothDevice>()
  private val subscribed = mutableSetOf<String>()
  private val queues = mutableMapOf<String, ArrayDeque<ByteArray>>()
  private val inFlight = mutableSetOf<String>()
  private val lock = Any()

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context is not available", null)

  private val manager: BluetoothManager
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

  override fun definition() = ModuleDefinition {
    Name("BlePeripheral")

    Events("onWrite", "onConnectionChange", "onSubscribe", "onMtuChanged")

    AsyncFunction("isSupported") {
      val adapter = manager.adapter
      adapter != null && adapter.isEnabled && adapter.isMultipleAdvertisementSupported
    }

    AsyncFunction("start") { serviceUuid: String, writeCharUuid: String, notifyCharUuid: String, nodeTagHex: String, promise: Promise ->
      try {
        startServer(UUID.fromString(serviceUuid), UUID.fromString(writeCharUuid), UUID.fromString(notifyCharUuid), hexToBytes(nodeTagHex), promise)
      } catch (e: SecurityException) {
        promise.reject("ERR_PERMISSION", "Bluetooth permission missing: ${e.message}", e)
      } catch (e: Exception) {
        promise.reject("ERR_START", e.message ?: "Could not start the GATT server", e)
      }
    }

    AsyncFunction("stop") {
      stopServer()
    }

    /** Queue one notification (≤ MTU − 3 bytes) for a subscribed peer. Returns false if the peer is not subscribed. */
    AsyncFunction("notify") { address: String, base64: String ->
      val value = Base64.decode(base64, Base64.NO_WRAP)
      val queued = synchronized(lock) {
        if (address in subscribed) {
          queues.getOrPut(address) { ArrayDeque() }.add(value)
          true
        } else {
          false
        }
      }
      if (queued) {
        pump(address)
      }
      queued
    }

    /** Peers currently connected to our GATT server. */
    AsyncFunction("connectedDevices") {
      synchronized(lock) { devices.keys.toList() }
    }

    OnDestroy {
      stopServer()
    }
  }

  // ── Server lifecycle ──────────────────────────────────────

  private fun startServer(serviceUuid: UUID, writeCharUuid: UUID, notifyCharUuid: UUID, nodeTag: ByteArray, promise: Promise) {
    stopServer()
    val adapter = manager.adapter ?: throw CodedException("ERR_NO_BLUETOOTH", "This device has no Bluetooth adapter", null)
    if (!adapter.isEnabled) {
      throw CodedException("ERR_BLUETOOTH_OFF", "Bluetooth is turned off", null)
    }
    val advertiser = adapter.bluetoothLeAdvertiser
      ?: throw CodedException("ERR_NO_ADVERTISER", "This device cannot advertise (BLE peripheral not supported)", null)

    writeUuid = writeCharUuid
    val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    val write = BluetoothGattCharacteristic(
      writeCharUuid,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    val notify = BluetoothGattCharacteristic(
      notifyCharUuid,
      BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    notify.addDescriptor(
      BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE),
    )
    service.addCharacteristic(write)
    service.addCharacteristic(notify)
    notifyCharacteristic = notify

    val server = manager.openGattServer(context, serverCallback)
      ?: throw CodedException("ERR_GATT_SERVER", "Could not open the GATT server", null)
    gattServer = server
    pendingStart = PendingStart(advertiser, serviceUuid, nodeTag, promise)
    // Advertising starts in onServiceAdded, once the service is registered.
    if (!server.addService(service)) {
      pendingStart = null
      stopServer()
      throw CodedException("ERR_GATT_SERVICE", "Could not add the GATT service", null)
    }
  }

  private data class PendingStart(
    val advertiser: android.bluetooth.le.BluetoothLeAdvertiser,
    val serviceUuid: UUID,
    val nodeTag: ByteArray,
    val promise: Promise,
  )

  private var pendingStart: PendingStart? = null

  private fun startAdvertising(p: PendingStart) {
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .setTimeout(0)
      .build()
    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(p.serviceUuid))
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .build()
    val scanResponse = AdvertiseData.Builder()
      .addManufacturerData(TEST_COMPANY_ID, p.nodeTag)
      .setIncludeDeviceName(false)
      .build()

    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
        p.promise.resolve(true)
      }

      override fun onStartFailure(errorCode: Int) {
        advertiseCallback = null
        p.promise.reject("ERR_ADVERTISE", "Advertising failed (error $errorCode)", null)
      }
    }
    advertiseCallback = callback
    p.advertiser.startAdvertising(settings, data, scanResponse, callback)
  }

  private fun stopServer() {
    try {
      advertiseCallback?.let { manager.adapter?.bluetoothLeAdvertiser?.stopAdvertising(it) }
    } catch (_: Exception) {
    }
    advertiseCallback = null
    try {
      gattServer?.clearServices()
      gattServer?.close()
    } catch (_: Exception) {
    }
    gattServer = null
    notifyCharacteristic = null
    synchronized(lock) {
      devices.clear()
      subscribed.clear()
      queues.clear()
      inFlight.clear()
    }
  }

  // ── Notification queue ───────────────────────────────────

  private fun pump(address: String) {
    val server = gattServer ?: return
    val characteristic = notifyCharacteristic ?: return
    val device: BluetoothDevice
    val value: ByteArray
    synchronized(lock) {
      if (address in inFlight) return
      val queue = queues[address] ?: return
      value = queue.pollFirst() ?: return
      device = devices[address] ?: return
      inFlight.add(address)
    }
    val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      server.notifyCharacteristicChanged(device, characteristic, false, value) == BluetoothGatt.GATT_SUCCESS
    } else {
      @Suppress("DEPRECATION")
      characteristic.value = value
      @Suppress("DEPRECATION")
      server.notifyCharacteristicChanged(device, characteristic, false)
    }
    if (!ok) {
      // Busy or failed: put it back and retry when the stack reports the last one sent.
      synchronized(lock) {
        inFlight.remove(address)
        queues[address]?.addFirst(value)
      }
    }
  }

  // ── GATT server callbacks ────────────────────────────────

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      val p = pendingStart ?: return
      pendingStart = null
      if (status == BluetoothGatt.GATT_SUCCESS) {
        try {
          startAdvertising(p)
        } catch (e: Exception) {
          p.promise.reject("ERR_ADVERTISE", e.message ?: "Advertising failed", e)
        }
      } else {
        p.promise.reject("ERR_GATT_SERVICE", "Adding the GATT service failed (status $status)", null)
      }
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      val connected = newState == BluetoothProfile.STATE_CONNECTED
      synchronized(lock) {
        if (connected) {
          devices[device.address] = device
        } else {
          devices.remove(device.address)
          subscribed.remove(device.address)
          queues.remove(device.address)
          inFlight.remove(device.address)
        }
      }
      sendEvent("onConnectionChange", mapOf("address" to device.address, "connected" to connected))
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      sendEvent("onMtuChanged", mapOf("address" to device.address, "mtu" to mtu))
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      val accepted = characteristic.uuid == writeUuid && !preparedWrite && offset == 0 && value != null
      if (responseNeeded) {
        gattServer?.sendResponse(
          device,
          requestId,
          if (accepted) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED,
          0,
          null,
        )
      }
      if (accepted) {
        sendEvent("onWrite", mapOf("address" to device.address, "value" to Base64.encodeToString(value, Base64.NO_WRAP)))
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (descriptor.uuid == CCCD_UUID && value != null) {
        val enabled = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        synchronized(lock) {
          if (enabled) subscribed.add(device.address) else subscribed.remove(device.address)
        }
        sendEvent("onSubscribe", mapOf("address" to device.address, "subscribed" to enabled))
      }
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      synchronized(lock) { inFlight.remove(device.address) }
      pump(device.address)
    }
  }

  companion object {
    private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private const val TEST_COMPANY_ID = 0xFFFF

    private fun hexToBytes(hex: String): ByteArray {
      require(hex.length % 2 == 0) { "Node tag must be an even number of hex digits" }
      return ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
  }
}
