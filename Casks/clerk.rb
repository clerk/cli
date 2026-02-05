cask "clerk" do
  version "0.2.0"

  on_intel do
    sha256 "26eaa5fe6011c8ec9be4d19ea1c06c8c43ddde2ef49763a283b508877a22fd46"
    url "https://github.com/clerk/cli/releases/download/v#{version}/clerk-v#{version}-darwin-amd64.pkg"
    pkg "clerk-v#{version}-darwin-amd64.pkg"
  end

  on_arm do
    sha256 "877c6b4ab158ff6e8c764a4ff067a213c19bca54ad644203db7b2285c362d356"
    url "https://github.com/clerk/cli/releases/download/v#{version}/clerk-v#{version}-darwin-arm64.pkg"
    pkg "clerk-v#{version}-darwin-arm64.pkg"
  end

  name "Clerk CLI"
  desc "Command-line interface for Clerk"
  homepage "https://clerk.com"

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
