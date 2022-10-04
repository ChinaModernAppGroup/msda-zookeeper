Summary: F5 Basic iApp
Name: f5-iapplx-msda-zk
Version: 0.0.4
Release: 0001
BuildArch: noarch
Group: Development/Libraries
License: Commercial
Packager: F5 Networks <support@f5.com>

%description
iApp for configuring a basic load balancer pool

%define IAPP_DIR /var/config/rest/iapps/%{name}

%prep
cp -r %{main}/src %{_builddir}/%{name}-%{version}

%build

%install
rm -rf $RPM_BUILD_ROOT
mkdir -p $RPM_BUILD_ROOT/%{IAPP_DIR}
echo `pwd`
cp -r $RPM_BUILD_DIR/%{name}-%{version}/* $RPM_BUILD_ROOT/%{IAPP_DIR}

%clean
rm -rf ${buildroot}

%files
%defattr(-,root,root)
%{IAPP_DIR}

%changelog
* Mon Jan 22 2018 iApp Dev <iappsdev@f5.com>
* Tue May 02 2022 Ping Xiong <p.xiong@f5.com>

- auto-generated this spec file

%define _binaries_in_noarch_packages_terminate_build   0