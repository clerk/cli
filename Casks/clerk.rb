cask "clerk" do
  version "0.0.8"

  on_intel do
    sha256 :no_check # Update with actual sha256 after first signed release
    url "https://github.com/clerk/cli/releases/download/v#{version}/clerk-v#{version}-darwin-amd64.pkg"
  end

  on_arm do
    sha256 :no_check # Update with actual sha256 after first signed release
    url "https://github.com/clerk/cli/releases/download/v#{version}/clerk-v#{version}-darwin-arm64.pkg"
  end

  name "Clerk CLI"
  desc "Command-line interface for Clerk"
  homepage "https://clerk.com"

  # The pkg installs to /usr/local/bin/clerk
  pkg "clerk-v#{version}-darwin-#{arch == :arm64 ? 'arm64' : 'amd64'}.pkg"

  uninstall pkgutil: "com.clerk.cli"

  zap trash: [
    "~/.config/clerk",
    "~/.clerk",
  ]

  caveats <<~EOS
    The Clerk CLI has been installed to /usr/local/bin/clerk

    To get started, authenticate with:
      clerk login
  EOS
end
