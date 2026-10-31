#include "napi/native_api.h"

#include <cstdint>
#include <memory>
#include <string>
#include <utility>

#include "libharmonycore.h"

// HnaCoreTestConfig is an optional entry point not present in all core builds.
// Declare it as a weak symbol so the linker accepts its absence; the runtime
// nullptr check in ExecuteAsync handles the missing case.
extern "C" __attribute__((weak)) int32_t HnaCoreTestConfig(char* configJSON, char* endpointTag);

namespace {

constexpr int32_t CORE_OK = 0;
constexpr int32_t CORE_INVALID_CONFIG = 3;
constexpr int32_t CORE_NOT_RUNNING = 5;

enum class Operation {
    INITIALIZE,
    VALIDATE,
    START,
    RELOAD,
    STOP,
    URL_TEST,
    TEST_CONFIG,
    SELECT_OUTBOUND,
    CONTROL,
    STATUS,
    TAILSCALE_STATUS,
    TAILSCALE_SET_EXIT_NODE,
    TAILSCALE_LOGOUT,
    TAILSCALE_PING,
    TAILDROP_SUBSCRIBE,
    TAILDROP_INBOX,
    TAILDROP_DOWNLOAD,
    TAILDROP_DELETE,
    TAILDROP_MARK_READ,
    TAILDROP_CANCEL_RECEIVE,
};

struct AsyncContext {
    napi_env env = nullptr;
    napi_deferred deferred = nullptr;
    napi_async_work work = nullptr;
    Operation operation = Operation::STATUS;
    std::string firstArgument;
    std::string secondArgument;
    std::string thirdArgument;
    int32_t tunFd = -1;
    int32_t resultCode = CORE_OK;
    int32_t numberResult = 0;
    bool running = false;
    bool includeSnapshot = true;
    int64_t uploadBytes = 0;
    int64_t downloadBytes = 0;
    int32_t activeConnections = 0;
    std::string selectedOutboundTag;
    std::string snapshotJson;
    std::string stringResult;
    std::string version;
    std::string error;
};

std::string CopyAndFree(char *value)
{
    if (value == nullptr) {
        return "";
    }
    std::string copied(value);
    HnaCoreFreeCString(value);
    return copied;
}

std::string ReadCoreVersion()
{
    return CopyAndFree(HnaCoreVersion());
}

std::string ReadCoreError()
{
    return CopyAndFree(HnaCoreLastError());
}

const char *OperationName(Operation operation)
{
    switch (operation) {
        case Operation::INITIALIZE:
            return "initialize";
        case Operation::VALIDATE:
            return "validateConfig";
        case Operation::START:
            return "start";
        case Operation::RELOAD:
            return "reload";
        case Operation::STOP:
            return "stop";
        case Operation::URL_TEST:
            return "urlTest";
        case Operation::TEST_CONFIG:
            return "testConfig";
        case Operation::SELECT_OUTBOUND:
            return "selectOutbound";
        case Operation::CONTROL:
            return "control";
        case Operation::STATUS:
            return "getStatus";
        case Operation::TAILSCALE_STATUS:
            return "tailscaleStatus";
        case Operation::TAILSCALE_SET_EXIT_NODE:
            return "tailscaleSetExitNode";
        case Operation::TAILSCALE_LOGOUT:
            return "tailscaleLogout";
        case Operation::TAILSCALE_PING:
            return "tailscalePing";
        case Operation::TAILDROP_SUBSCRIBE:
            return "taildropSubscribe";
        case Operation::TAILDROP_INBOX:
            return "taildropInbox";
        case Operation::TAILDROP_DOWNLOAD:
            return "taildropDownload";
        case Operation::TAILDROP_DELETE:
            return "taildropDelete";
        case Operation::TAILDROP_MARK_READ:
            return "taildropMarkRead";
        case Operation::TAILDROP_CANCEL_RECEIVE:
            return "taildropCancelReceive";
    }
    return "unknown";
}

std::string ErrorMessage(const AsyncContext &context)
{
    switch (context.resultCode) {
        case 1:
            return "sing-box core is not initialized";
        case 2:
            return std::string(OperationName(context.operation)) + " received an invalid argument";
        case CORE_INVALID_CONFIG:
            return context.error.empty() ? "sing-box configuration is invalid" : context.error;
        case 4:
            return "sing-box core is already running";
        case CORE_NOT_RUNNING:
            return "sing-box core is not running";
        case 6:
            return context.error.empty() ? "sing-box core reported an internal error" : context.error;
        default:
            break;
    }
    if (!context.error.empty()) {
        return context.error;
    }
    return std::string(OperationName(context.operation)) +
        " failed with native core error " + std::to_string(context.resultCode);
}

napi_value CreateString(napi_env env, const std::string &value)
{
    napi_value result = nullptr;
    napi_create_string_utf8(env, value.c_str(), value.size(), &result);
    return result;
}

void SetNamedBoolean(napi_env env, napi_value object, const char *name, bool value)
{
    napi_value nativeValue = nullptr;
    napi_get_boolean(env, value, &nativeValue);
    napi_set_named_property(env, object, name, nativeValue);
}

void SetNamedInt64(napi_env env, napi_value object, const char *name, int64_t value)
{
    napi_value nativeValue = nullptr;
    napi_create_int64(env, value, &nativeValue);
    napi_set_named_property(env, object, name, nativeValue);
}

void SetNamedString(napi_env env, napi_value object, const char *name, const std::string &value)
{
    napi_set_named_property(env, object, name, CreateString(env, value));
}

bool ReadRequiredString(napi_env env, napi_value value, const char *argumentName, std::string &result)
{
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
        const std::string message = std::string(argumentName) + " must be a string";
        napi_throw_type_error(env, nullptr, message.c_str());
        return false;
    }

    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
        const std::string message = std::string("Unable to read ") + argumentName;
        napi_throw_type_error(env, nullptr, message.c_str());
        return false;
    }
    if (length == 0) {
        const std::string message = std::string(argumentName) + " must not be empty";
        napi_throw_range_error(env, nullptr, message.c_str());
        return false;
    }

    std::string buffer(length + 1, '\0');
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &copied) != napi_ok) {
        const std::string message = std::string("Unable to read ") + argumentName;
        napi_throw_type_error(env, nullptr, message.c_str());
        return false;
    }
    buffer.resize(copied);
    result = std::move(buffer);
    return true;
}

bool ReadRequiredInt32(napi_env env, napi_value value, const char *argumentName, int32_t &result)
{
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
        const std::string message = std::string(argumentName) + " must be a number";
        napi_throw_type_error(env, nullptr, message.c_str());
        return false;
    }
    if (napi_get_value_int32(env, value, &result) != napi_ok || result < 0) {
        const std::string message = std::string(argumentName) + " must be a non-negative int32";
        napi_throw_range_error(env, nullptr, message.c_str());
        return false;
    }
    return true;
}

void ExecuteAsync(napi_env env, void *data)
{
    auto *context = static_cast<AsyncContext *>(data);
    switch (context->operation) {
        case Operation::INITIALIZE:
            context->resultCode = HnaCoreInitialize(
                context->firstArgument.data(), context->secondArgument.data());
            break;
        case Operation::VALIDATE:
            context->resultCode = HnaCoreValidateConfig(context->firstArgument.data());
            break;
        case Operation::START:
            context->resultCode = HnaCoreStart(context->tunFd, context->firstArgument.data());
            break;
        case Operation::RELOAD:
            context->resultCode = HnaCoreReload(context->firstArgument.data());
            break;
        case Operation::STOP:
            context->resultCode = HnaCoreStop();
            // Stopping an already stopped core is intentionally idempotent.
            if (context->resultCode == CORE_NOT_RUNNING) {
                context->resultCode = CORE_OK;
            }
            break;
        case Operation::URL_TEST:
            context->numberResult = HnaCoreURLTest(context->firstArgument.data());
            context->resultCode = context->numberResult >= 0 ? CORE_OK : context->numberResult;
            break;
        case Operation::TEST_CONFIG:
            if (HnaCoreTestConfig == nullptr) {
                // Backup cores built before 0.2.35 do not provide the temporary
                // node-test entry point; report it instead of failing to load.
                context->resultCode = CORE_INVALID_CONFIG;
                break;
            }
            context->numberResult = HnaCoreTestConfig(context->firstArgument.data(), context->secondArgument.data());
            context->resultCode = context->numberResult >= 0 ? CORE_OK : context->numberResult;
            break;
        case Operation::SELECT_OUTBOUND:
            context->resultCode = HnaCoreSelectOutbound(context->firstArgument.data());
            if (context->resultCode == CORE_OK) {
                context->selectedOutboundTag = CopyAndFree(HnaCoreSelectedOutboundTag(
                    const_cast<char *>("proxy")));
            }
            break;
        case Operation::CONTROL:
            context->resultCode = HnaCoreControl(const_cast<char *>(context->firstArgument.c_str()));
            break;
        case Operation::STATUS: {
            int32_t running = 0;
            context->resultCode = HnaCoreGetStatus(
                &running,
                &context->uploadBytes,
                &context->downloadBytes,
                &context->activeConnections);
            context->snapshotJson = context->includeSnapshot ? CopyAndFree(HnaCoreRuntimeSnapshot()) : "{}";
            context->running = running == 1;
            if (context->resultCode == CORE_OK && context->running) {
                context->selectedOutboundTag = CopyAndFree(HnaCoreSelectedOutboundTag(
                    const_cast<char *>("proxy")));
            }
            break;
        }
        case Operation::TAILSCALE_STATUS:
            context->stringResult = CopyAndFree(HnaCoreTailscaleStatus());
            context->resultCode = CORE_OK;
            break;
        case Operation::TAILSCALE_SET_EXIT_NODE:
            context->resultCode = HnaCoreTailscaleSetExitNode(
                const_cast<char *>(context->firstArgument.c_str()),
                const_cast<char *>(context->secondArgument.c_str()));
            break;
        case Operation::TAILSCALE_LOGOUT:
            context->resultCode = HnaCoreTailscaleLogout(
                const_cast<char *>(context->firstArgument.c_str()));
            break;
        case Operation::TAILSCALE_PING:
            context->stringResult = CopyAndFree(HnaCoreTailscalePing(
                const_cast<char *>(context->firstArgument.c_str()),
                const_cast<char *>(context->secondArgument.c_str())));
            context->resultCode = CORE_OK;
            break;
        case Operation::TAILDROP_SUBSCRIBE:
            context->resultCode = HnaCoreTaildropSubscribe(
                const_cast<char *>(context->firstArgument.c_str()));
            break;
        case Operation::TAILDROP_INBOX:
            context->stringResult = CopyAndFree(HnaCoreTaildropInbox(
                const_cast<char *>(context->firstArgument.c_str())));
            context->resultCode = CORE_OK;
            break;
        case Operation::TAILDROP_DOWNLOAD:
            context->resultCode = HnaCoreTaildropDownload(
                const_cast<char *>(context->firstArgument.c_str()),
                const_cast<char *>(context->secondArgument.c_str()),
                const_cast<char *>(context->thirdArgument.c_str()));
            break;
        case Operation::TAILDROP_DELETE:
            context->resultCode = HnaCoreTaildropDelete(
                const_cast<char *>(context->firstArgument.c_str()),
                const_cast<char *>(context->secondArgument.c_str()));
            break;
        case Operation::TAILDROP_MARK_READ:
            context->resultCode = HnaCoreTaildropMarkRead(
                const_cast<char *>(context->firstArgument.c_str()));
            break;
        case Operation::TAILDROP_CANCEL_RECEIVE:
            context->resultCode = HnaCoreTaildropCancelReceive(
                const_cast<char *>(context->firstArgument.c_str()),
                const_cast<char *>(context->secondArgument.c_str()),
                const_cast<char *>(context->thirdArgument.c_str()));
            break;
    }

    context->version = ReadCoreVersion();
    context->error = ReadCoreError();
}

napi_value CreateResolvedValue(napi_env env, const AsyncContext &context)
{
    napi_value value = nullptr;
    napi_create_object(env, &value);

    switch (context.operation) {
        case Operation::INITIALIZE:
            SetNamedBoolean(env, value, "available", true);
            SetNamedString(env, value, "version", context.version);
            SetNamedString(env, value, "reason", "");
            return value;
        case Operation::VALIDATE:
            SetNamedBoolean(env, value, "valid", context.resultCode == CORE_OK);
            SetNamedString(env, value, "error", context.error);
            return value;
        case Operation::STATUS:
            SetNamedBoolean(env, value, "running", context.running);
            SetNamedInt64(env, value, "uploadBytes", context.uploadBytes);
            SetNamedInt64(env, value, "downloadBytes", context.downloadBytes);
            SetNamedInt64(env, value, "activeConnections", context.activeConnections);
            SetNamedString(env, value, "selectedOutboundTag", context.selectedOutboundTag);
            SetNamedString(env, value, "version", context.version);
            SetNamedString(env, value, "lastError", context.error);
            SetNamedString(env, value, "snapshotJson", context.snapshotJson);
            return value;
        case Operation::URL_TEST:
        case Operation::TEST_CONFIG:
            napi_create_int32(env, context.numberResult, &value);
            return value;
        case Operation::SELECT_OUTBOUND:
            return CreateString(env, context.selectedOutboundTag);
        case Operation::TAILSCALE_STATUS:
        case Operation::TAILSCALE_PING:
        case Operation::TAILDROP_INBOX:
            return CreateString(env, context.stringResult);
        case Operation::TAILSCALE_SET_EXIT_NODE:
        case Operation::TAILSCALE_LOGOUT:
        case Operation::TAILDROP_SUBSCRIBE:
        case Operation::TAILDROP_DOWNLOAD:
        case Operation::TAILDROP_DELETE:
        case Operation::TAILDROP_MARK_READ:
        case Operation::TAILDROP_CANCEL_RECEIVE:
        case Operation::CONTROL:
        case Operation::START:
        case Operation::RELOAD:
        case Operation::STOP:
            napi_get_undefined(env, &value);
            return value;
    }
    napi_get_undefined(env, &value);
    return value;
}

void CompleteAsync(napi_env env, napi_status status, void *data)
{
    std::unique_ptr<AsyncContext> context(static_cast<AsyncContext *>(data));

    const bool validationFailure =
        context->operation == Operation::VALIDATE && context->resultCode == CORE_INVALID_CONFIG;
    const bool succeeded = status == napi_ok &&
        (context->resultCode == CORE_OK || validationFailure);

    if (succeeded) {
        napi_resolve_deferred(env, context->deferred, CreateResolvedValue(env, *context));
    } else {
        if (status != napi_ok && context->error.empty()) {
            context->error = "Native async work did not complete";
        }
        const std::string message = ErrorMessage(*context);
        napi_value errorMessage = CreateString(env, message);
        napi_value error = nullptr;
        napi_create_error(env, nullptr, errorMessage, &error);
        SetNamedInt64(env, error, "code", context->resultCode);
        SetNamedString(env, error, "operation", OperationName(context->operation));
        napi_reject_deferred(env, context->deferred, error);
    }

    napi_delete_async_work(env, context->work);
}

napi_value QueueAsync(napi_env env, std::unique_ptr<AsyncContext> context)
{
    napi_value promise = nullptr;
    if (napi_create_promise(env, &context->deferred, &promise) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to create native core Promise");
        return nullptr;
    }

    context->env = env;
    napi_value resourceName = CreateString(env,
        std::string("HarmonyNetworkAssistant.") + OperationName(context->operation));
    if (napi_create_async_work(env, nullptr, resourceName, ExecuteAsync, CompleteAsync,
        context.get(), &context->work) != napi_ok) {
        napi_throw_error(env, nullptr, "Unable to create native core async work");
        return nullptr;
    }
    if (napi_queue_async_work(env, context->work) != napi_ok) {
        napi_delete_async_work(env, context->work);
        napi_throw_error(env, nullptr, "Unable to queue native core async work");
        return nullptr;
    }

    context.release();
    return promise;
}

napi_value Initialize(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) {
        napi_throw_type_error(env, nullptr,
            "initialize requires workingDirectory and temporaryDirectory");
        return nullptr;
    }

    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::INITIALIZE;
    if (!ReadRequiredString(env, args[0], "workingDirectory", context->firstArgument) ||
        !ReadRequiredString(env, args[1], "temporaryDirectory", context->secondArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value ValidateConfig(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "validateConfig requires configJson");
        return nullptr;
    }

    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::VALIDATE;
    if (!ReadRequiredString(env, args[0], "configJson", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value Start(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) {
        napi_throw_type_error(env, nullptr, "start requires tunFd and configJson");
        return nullptr;
    }

    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::START;
    if (!ReadRequiredInt32(env, args[0], "tunFd", context->tunFd) ||
        !ReadRequiredString(env, args[1], "configJson", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value Reload(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "reload requires configJson");
        return nullptr;
    }

    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::RELOAD;
    if (!ReadRequiredString(env, args[0], "configJson", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value Stop(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr);
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::STOP;
    return QueueAsync(env, std::move(context));
}

napi_value UrlTest(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "urlTest requires nodeTag");
        return nullptr;
    }

    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::URL_TEST;
    if (!ReadRequiredString(env, args[0], "nodeTag", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TestConfig(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) {
        napi_throw_type_error(env, nullptr, "testConfig requires config and nodeTag");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TEST_CONFIG;
    if (!ReadRequiredString(env, args[0], "config", context->firstArgument) ||
        !ReadRequiredString(env, args[1], "nodeTag", context->secondArgument)) return nullptr;
    return QueueAsync(env, std::move(context));
}

napi_value SelectOutbound(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "selectOutbound requires nodeTag");
        return nullptr;
    }

    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::SELECT_OUTBOUND;
    if (!ReadRequiredString(env, args[0], "nodeTag", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value Control(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::CONTROL;
    if (argc != 1 || !ReadRequiredString(env, args[0], "payload", context->firstArgument)) return nullptr;
    return QueueAsync(env, std::move(context));
}
napi_value GetStatus(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr);
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::STATUS;
    return QueueAsync(env, std::move(context));
}

napi_value GetStatusLite(napi_env env, napi_callback_info info)
{
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::STATUS;
    context->includeSnapshot = false;
    return QueueAsync(env, std::move(context));
}

napi_value Version(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr);
    return CreateString(env, ReadCoreVersion());
}

napi_value LastError(napi_env env, napi_callback_info info)
{
    size_t argc = 0;
    napi_get_cb_info(env, info, &argc, nullptr, nullptr, nullptr);
    return CreateString(env, ReadCoreError());
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailscale N-API functions
// ─────────────────────────────────────────────────────────────────────────────

napi_value TailscaleStatus(napi_env env, napi_callback_info info)
{
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILSCALE_STATUS;
    return QueueAsync(env, std::move(context));
}

napi_value TailscaleSetExitNode(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) {
        napi_throw_type_error(env, nullptr,
            "tailscaleSetExitNode requires endpointTag and stableID");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILSCALE_SET_EXIT_NODE;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument) ||
        !ReadRequiredString(env, args[1], "stableID", context->secondArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TailscaleLogout(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "tailscaleLogout requires endpointTag");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILSCALE_LOGOUT;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TailscalePing(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) {
        napi_throw_type_error(env, nullptr,
            "tailscalePing requires endpointTag and peerIP");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILSCALE_PING;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument) ||
        !ReadRequiredString(env, args[1], "peerIP", context->secondArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TaildropSubscribe(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "taildropSubscribe requires endpointTag");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILDROP_SUBSCRIBE;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TaildropInbox(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "taildropInbox requires endpointTag");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILDROP_INBOX;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TaildropDownload(napi_env env, napi_callback_info info)
{
    size_t argc = 3;
    napi_value args[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 3) {
        napi_throw_type_error(env, nullptr,
            "taildropDownload requires endpointTag, name, and destinationPath");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILDROP_DOWNLOAD;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument) ||
        !ReadRequiredString(env, args[1], "name", context->secondArgument) ||
        !ReadRequiredString(env, args[2], "destinationPath", context->thirdArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TaildropDelete(napi_env env, napi_callback_info info)
{
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 2) {
        napi_throw_type_error(env, nullptr,
            "taildropDelete requires endpointTag and name");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILDROP_DELETE;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument) ||
        !ReadRequiredString(env, args[1], "name", context->secondArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TaildropMarkRead(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = {nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 1) {
        napi_throw_type_error(env, nullptr, "taildropMarkRead requires endpointTag");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILDROP_MARK_READ;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

napi_value TaildropCancelReceive(napi_env env, napi_callback_info info)
{
    size_t argc = 3;
    napi_value args[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc != 3) {
        napi_throw_type_error(env, nullptr,
            "taildropCancelReceive requires endpointTag, senderID, and name");
        return nullptr;
    }
    auto context = std::make_unique<AsyncContext>();
    context->operation = Operation::TAILDROP_CANCEL_RECEIVE;
    if (!ReadRequiredString(env, args[0], "endpointTag", context->firstArgument) ||
        !ReadRequiredString(env, args[1], "senderID", context->secondArgument) ||
        !ReadRequiredString(env, args[2], "name", context->thirdArgument)) {
        return nullptr;
    }
    return QueueAsync(env, std::move(context));
}

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor descriptors[] = {
        {"initialize", nullptr, Initialize, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"validateConfig", nullptr, ValidateConfig, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"reload", nullptr, Reload, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"urlTest", nullptr, UrlTest, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"testConfig", nullptr, TestConfig, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"selectOutbound", nullptr, SelectOutbound, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"control", nullptr, Control, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getStatus", nullptr, GetStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getStatusLite", nullptr, GetStatusLite, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"lastError", nullptr, LastError, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"tailscaleStatus", nullptr, TailscaleStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"tailscaleSetExitNode", nullptr, TailscaleSetExitNode, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"tailscaleLogout", nullptr, TailscaleLogout, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"tailscalePing", nullptr, TailscalePing, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"taildropSubscribe", nullptr, TaildropSubscribe, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"taildropInbox", nullptr, TaildropInbox, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"taildropDownload", nullptr, TaildropDownload, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"taildropDelete", nullptr, TaildropDelete, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"taildropMarkRead", nullptr, TaildropMarkRead, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"taildropCancelReceive", nullptr, TaildropCancelReceive, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports,
        sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
    return exports;
}
EXTERN_C_END

static napi_module harmonyCoreModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "entry",
    .nm_priv = nullptr,
    .reserved = {0},
};

} // namespace

extern "C" __attribute__((constructor)) void RegisterHarmonyCoreModule()
{
    napi_module_register(&harmonyCoreModule);
}
