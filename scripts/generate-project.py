#!/usr/bin/env python3
"""Generate a deterministic, dependency-free Xcode project. Never edits user settings."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
objects = {}

def uid(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24].upper()

def obj(key, isa, **values):
    ident = uid(key)
    objects[ident] = {"isa": isa, **values}
    return ident

def file(path, kind):
    return obj(path, "PBXFileReference", lastKnownFileType=kind, path=path, sourceTree="<group>")

def build(path, reference, **extra):
    return obj("build:" + path, "PBXBuildFile", fileRef=reference, **extra)

def config_list(name, settings):
    configs = []
    for variant in ["Debug", "Release"]:
        merged = dict(settings)
        merged.update(SWIFT_OPTIMIZATION_LEVEL="-Onone" if variant == "Debug" else "-O",
                      DEBUG_INFORMATION_FORMAT="dwarf" if variant == "Debug" else "dwarf-with-dsym")
        if variant == "Debug": merged["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "DEBUG"
        configs.append(obj(f"{name}:{variant}", "XCBuildConfiguration", name=variant, buildSettings=merged))
    return obj(name + ":configs", "XCConfigurationList", buildConfigurations=configs, defaultConfigurationIsVisible="0", defaultConfigurationName="Release")

shared = [str(p.relative_to(ROOT)) for p in sorted((ROOT / "native/Shared").glob("*.swift"))]
app_sources = [str(p.relative_to(ROOT)) for p in sorted((ROOT / "native/App").glob("*.swift"))]
extension_sources = ["native/Extension/SafariWebExtensionHandler.swift"]
refs = {path: file(path, "sourcecode.swift") for path in shared + app_sources + extension_sources}
resources = ["extension/manifest.json", "extension/background.bundle.js", "extension/core", "extension/content", "extension/panel", "extension/icons"]
for path in resources: refs[path] = file(path, "folder" if (ROOT / path).is_dir() else "text.json" if path.endswith("json") else "sourcecode.javascript")
icon = file("native/App/AppIcon.icns", "image.icns")
app_product = obj("app-product", "PBXFileReference", explicitFileType="wrapper.application", path="Safari Chat.app", sourceTree="BUILT_PRODUCTS_DIR", includeInIndex="0")
ext_product = obj("ext-product", "PBXFileReference", explicitFileType="wrapper.app-extension", path="Safari Chat Extension.appex", sourceTree="BUILT_PRODUCTS_DIR", includeInIndex="0")
products = obj("products", "PBXGroup", children=[app_product, ext_product], name="Products", sourceTree="<group>")
root_group = obj("root-group", "PBXGroup", children=list(refs.values()) + [icon, products], sourceTree="<group>")

common = {"SDKROOT": "macosx", "MACOSX_DEPLOYMENT_TARGET": "14.0", "SWIFT_VERSION": "5.0",
          "SAFARI_CHAT_BUNDLE_ID": "org.safarichat.app", "SAFARI_CHAT_GROUP_ID": "org.safarichat.shared",
          "CLANG_ENABLE_MODULES": "YES", "SWIFT_STRICT_CONCURRENCY": "complete", "ENABLE_HARDENED_RUNTIME": "YES",
          "CODE_SIGN_STYLE": "Automatic", "GENERATE_INFOPLIST_FILE": "NO", "CURRENT_PROJECT_VERSION": "1",
          "MARKETING_VERSION": "0.1.0", "COMBINE_HIDPI_IMAGES": "YES", "ENABLE_USER_SCRIPT_SANDBOXING": "YES"}
app_settings = {**common, "PRODUCT_BUNDLE_IDENTIFIER": "$(SAFARI_CHAT_BUNDLE_ID)", "PRODUCT_NAME": "Safari Chat",
                "INFOPLIST_FILE": "native/App/Info.plist", "CODE_SIGN_ENTITLEMENTS": "native/App/App.entitlements",
                "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/../Frameworks"]}
ext_settings = {**common, "PRODUCT_BUNDLE_IDENTIFIER": "$(SAFARI_CHAT_BUNDLE_ID).Extension", "PRODUCT_NAME": "Safari Chat Extension",
                "INFOPLIST_FILE": "native/Extension/Info.plist", "CODE_SIGN_ENTITLEMENTS": "native/Extension/Extension.entitlements",
                "APPLICATION_EXTENSION_API_ONLY": "YES", "SKIP_INSTALL": "YES",
                "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/../Frameworks", "@executable_path/../../../../Frameworks"]}

def sources_phase(name, paths):
    return obj(name + ":sources", "PBXSourcesBuildPhase", buildActionMask="2147483647", files=[build(name + path, refs[path]) for path in paths], runOnlyForDeploymentPostprocessing="0")

def resources_phase(name, files):
    return obj(name + ":resources", "PBXResourcesBuildPhase", buildActionMask="2147483647", files=files, runOnlyForDeploymentPostprocessing="0")

ext_target = obj("extension-target", "PBXNativeTarget", name="Safari Chat Extension", productName="Safari Chat Extension", productReference=ext_product,
                 productType="com.apple.product-type.app-extension", buildConfigurationList=config_list("extension", ext_settings),
                 buildPhases=[sources_phase("extension", shared + extension_sources), resources_phase("extension", [build(path, refs[path]) for path in resources])], dependencies=[], buildRules=[])
proxy = obj("extension-proxy", "PBXContainerItemProxy", containerPortal=uid("project"), proxyType="1", remoteGlobalIDString=ext_target, remoteInfo="Safari Chat Extension")
dependency = obj("extension-dependency", "PBXTargetDependency", target=ext_target, targetProxy=proxy)
embed = obj("embed", "PBXCopyFilesBuildPhase", buildActionMask="2147483647", dstPath="", dstSubfolderSpec="13", name="Embed App Extensions", files=[build("embed", ext_product, settings={"ATTRIBUTES": ["RemoveHeadersOnCopy"]})], runOnlyForDeploymentPostprocessing="0")
app_target = obj("app-target", "PBXNativeTarget", name="Safari Chat", productName="Safari Chat", productReference=app_product,
                 productType="com.apple.product-type.application", buildConfigurationList=config_list("app", app_settings),
                 buildPhases=[sources_phase("app", shared + app_sources), resources_phase("app", [build("app-icon", icon)]), embed], dependencies=[dependency], buildRules=[])
project = obj("project", "PBXProject", attributes={"LastUpgradeCheck": "1600", "BuildIndependentTargetsInParallel": "YES",
              "TargetAttributes": {app_target: {"CreatedOnToolsVersion": "16.0", "SystemCapabilities": {"com.apple.ApplicationGroups.iOS": {"enabled": "1"}, "com.apple.Keychain": {"enabled": "1"}}},
                                   ext_target: {"CreatedOnToolsVersion": "16.0", "SystemCapabilities": {"com.apple.ApplicationGroups.iOS": {"enabled": "1"}, "com.apple.Keychain": {"enabled": "1"}}}}},
              buildConfigurationList=config_list("project", {"ALWAYS_SEARCH_USER_PATHS": "NO"}), compatibilityVersion="Xcode 14.0", developmentRegion="en", hasScannedForEncodings="0", knownRegions=["en", "Base"], mainGroup=root_group, productRefGroup=products, projectDirPath="", projectRoot="", targets=[app_target, ext_target])

def encode(value, depth=0):
    indent = "\t" * depth
    if isinstance(value, dict):
        return "{\n" + "".join("\t" * (depth + 1) + json.dumps(k) + " = " + encode(v, depth + 1) + ";\n" for k, v in value.items()) + indent + "}"
    if isinstance(value, list): return "(" + ", ".join(encode(v, depth) for v in value) + ")"
    return json.dumps(value)

directory = ROOT / "SafariChat.xcodeproj"
directory.mkdir(exist_ok=True)
(directory / "project.pbxproj").write_text("// !$*UTF8*$!\n" + encode({"archiveVersion": "1", "classes": {}, "objectVersion": "56", "objects": objects, "rootObject": project}) + "\n")
schemes = directory / "xcshareddata/xcschemes"
schemes.mkdir(parents=True, exist_ok=True)
(schemes / "Safari Chat.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="Safari Chat.app" BlueprintName="Safari Chat" ReferencedContainer="container:SafariChat.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug"/>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="Safari Chat.app" BlueprintName="Safari Chat" ReferencedContainer="container:SafariChat.xcodeproj"/></BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release"/><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
print("Generated SafariChat.xcodeproj")
