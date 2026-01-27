class Clerk < Formula
  desc "CLI for managing Clerk authentication instances"
  homepage "https://github.com/clerk/gocli"
  url "git@github.com:clerk/gocli.git",
    tag: "v0.0.1",
    revision: "HEAD"
  license "MIT"
  head "git@github.com:clerk/gocli.git", branch: "main"

  depends_on "go" => :build

  def install
    ldflags = "-s -w -X clerk.com/cli/internal/cmd.Version=#{version}"
    system "go", "build", *std_go_args(ldflags:), "./cmd/clerk"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/clerk --version")
  end
end
