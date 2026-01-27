class Clerk < Formula
  desc "CLI for managing Clerk authentication instances"
  homepage "https://github.com/clerk/gocli"
  url "https://github.com/clerk/gocli.git",
    tag: "v0.0.1",
    revision: "151eee4278266060d8c52866368b3b0e1cf3ab60"
  license "MIT"
  head "https://github.com/clerk/gocli.git", branch: "main"

  depends_on "go" => :build

  def install
    ldflags = "-s -w -X clerk.com/cli/internal/cmd.Version=#{version}"
    system "go", "build", *std_go_args(ldflags:), "./cmd/clerk"

    generate_completions_from_executable(bin/"clerk", "completion")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/clerk --version")
  end
end
