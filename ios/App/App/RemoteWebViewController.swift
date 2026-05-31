import UIKit
import Capacitor
import SystemConfiguration

// FakanOS loads its web layer live from https://os.fakan.cz (see capacitor.config.json
// `server.url`) so deploys land in the app without a rebuild. The downside of a remote
// server URL is that, offline, WKWebView would show a blank page.
//
// This controller adds an offline fallback: at launch we probe reachability of the
// remote host. If it's unreachable, we strip `serverURL` from the instance descriptor,
// which makes Capacitor serve the web assets bundled into the app (App/App/public,
// i.e. the last `cap sync`'d `www/`) instead. Online → live remote; offline → bundled copy.
//
// The decision is made once at launch (cleanest hook, no fighting the bridge's own
// navigation delegate). A session that goes offline after loading keeps its loaded page;
// only a cold start with no network falls back to the bundle.
class RemoteWebViewController: CAPBridgeViewController {

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()

        if let serverURL = descriptor.serverURL,
           let host = URL(string: serverURL)?.host,
           !Self.isHostReachable(host) {
            // Offline (or host down): fall back to the bundled web assets.
            descriptor.serverURL = nil
            CAPLog.print("⚡️  RemoteWebViewController: \(host) unreachable, using bundled web assets")
        }

        return descriptor
    }

    /// Synchronous, dependency-free reachability check via SystemConfiguration.
    /// Returns true unless we can positively determine the host is unreachable,
    /// so a flaky probe never traps a perfectly online device on the stale bundle.
    private static func isHostReachable(_ host: String) -> Bool {
        guard let reachability = SCNetworkReachabilityCreateWithName(nil, host) else {
            return true
        }
        var flags = SCNetworkReachabilityFlags()
        guard SCNetworkReachabilityGetFlags(reachability, &flags) else {
            return true
        }
        let isReachable = flags.contains(.reachable)
        let needsConnection = flags.contains(.connectionRequired)
        return isReachable && !needsConnection
    }
}
